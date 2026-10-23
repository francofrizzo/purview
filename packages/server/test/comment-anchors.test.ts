import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commentsPath, appendEvents, writeRevision, parseDiff, toRevisionFiles } from "@reviewer/core";
import { buildFixture, key } from "./fixtures.js";
import { addComment, readComments, writeComments } from "../src/comments.js";
import { parseLineMap, parseRenames, reanchorComments, type GitRunner } from "../src/comment-anchors.js";

describe("zero context line maps", () => {
  it("shifts insertions and deletions before unchanged lines", () => {
    expect(parseLineMap("@@ -2,0 +3,2 @@\n+a\n+b")(3)).toBe(5);
    expect(parseLineMap("@@ -2,2 +1,0 @@\n-a\n-b")(5)).toBe(3);
    expect(parseLineMap("@@ -0,0 +1 @@\n+a")(1)).toBe(2);
  });
  it("marks replacements and deleted files gone", () => {
    expect(parseLineMap("@@ -2,2 +2 @@\n-a\n-b\n+c")(3)).toBeNull();
    expect(parseLineMap("deleted file mode 100644\n@@ -1 +0,0 @@\n-a")(1)).toBeNull();
  });
  it("reads renames with spaces and preserves pure rename lines", () => {
    expect(parseRenames("R100\0old name\0new name\0").get("old name")).toBe("new name");
    expect(parseLineMap("similarity index 100%\nrename from a\nrename to b")(8)).toBe(8);
  });
});
let root: string;
afterEach(() => { if(root) fs.rmSync(root, { recursive: true, force: true }); });
function setup() {
 root = fs.mkdtempSync(path.join(os.tmpdir(), "anchors-"));
 buildFixture(root);
 const c = addComment(key, { file: "src/foo.ts", line: 3, side: "RIGHT", body: "anchor" }, root);
 // Fixture already has two revisions; model comments written on the first.
 const patch = "diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new\n";
 const files = parseDiff(patch);
 writeRevision(key,2,patch,files,{baseSha:"base1",headSha:"head2",mergeBase:"mb1"},root);
 appendEvents(key,[{type:"revision-added",revision:2,baseSha:"base1",headSha:"head2",mergeBase:"mb1",baseOnly:false,files:toRevisionFiles(files)}],root);
 c.revision = 1;
 return c;
}
const git: GitRunner = async (_repo, args) => args.includes("-U0") ? "@@ -1,0 +2,2 @@\n+a\n+b" : "";
it("maps drafts and pushed comments, leaving replies and files alone", async () => {
 const c = setup();
 writeComments(key, [c, {...c,id:"pushed",status:"pushed"}, {...c,id:"reply",inReplyTo:"thread"}, {...c,id:"file",subjectType:"file",line:undefined,side:undefined}], root);
 await reanchorComments(key,root,{path:"/stub"},git);
 const result = readComments(key,root);
 expect(result.map(c=>c.line)).toEqual([5,5,3,undefined]);
 expect(result[0].revision).toBe(2);
});
it("marks deleted code outdated even when the old line remains in the diff", async () => {
 const c=setup(); writeComments(key,[c],root);
 await reanchorComments(key,root,{path:"/stub"},async (_repo,args)=>args.includes("-U0")?"@@ -3 +3 @@\n-old\n+new":"");
 expect(readComments(key,root)[0].outdated).toEqual({line:3,revision:1});
});
it("falls back when the old commit is missing", async () => {
 const c=setup(); writeComments(key,[c],root);
 await reanchorComments(key,root,{path:"/stub"},async()=>{throw Error("missing object")});
 expect(readComments(key,root)[0].revision).toBe(1);
});
it("persists the current revision when reading a legacy comment", () => {
 const c=setup(); const {revision,...legacy}=c;
 fs.writeFileSync(commentsPath(key,root),JSON.stringify([legacy]));
 expect(readComments(key,root)[0].revision).toBe(2);
 expect(JSON.parse(fs.readFileSync(commentsPath(key,root),"utf8"))[0].revision).toBe(2);
});
it("maps renames and caches the diff for comments sharing a file", async () => {
 const c=setup(); writeComments(key,[c,{...c,id:"second"}],root);
 let diffs=0, names=0;
 await reanchorComments(key,root,{path:"/stub"},async (_repo,args)=> {
  if(args.includes("--name-status")) { names++; return "R100\0src/foo.ts\0src/bar.ts\0"; }
  if(args.includes("-U0")) diffs++;
  return "";
 });
 expect(readComments(key,root).map(c=>c.file)).toEqual(["src/bar.ts","src/bar.ts"]);
 expect([diffs,names]).toEqual([1,1]);
});
it("keeps LEFT lines when the diff base is unchanged", async () => {
 const c=setup(); writeComments(key,[{...c,side:"LEFT"}],root);
 await reanchorComments(key,root,{path:"/stub"},git);
 expect(readComments(key,root)[0]).toMatchObject({line:3,revision:2});
});
it("preserves edits and comments created during asynchronous mapping", async () => {
 const c=setup(); writeComments(key,[c],root);
 let edited=false;
 await reanchorComments(key,root,{path:"/stub"},async (repo,args)=> {
  if(!edited) {
   edited=true;
   writeComments(key,[{...c,body:"edited"}],root);
   addComment(key,{file:c.file,line:8,side:"RIGHT",body:"new"},root);
  }
  return git(repo,args);
 });
 expect(readComments(key,root).map(c=>[c.body,c.line])).toEqual([["edited",5],["new",8]]);
});
it("marks a range outdated when an interior line was removed", async () => {
 const c=setup(); writeComments(key,[{...c,line:8,startLine:2,startSide:"RIGHT"}],root);
 await reanchorComments(key,root,{path:"/stub"},async (_repo,args)=>args.includes("-U0")?"@@ -4 +3,0 @@\n-deleted":"");
 expect(readComments(key,root)[0]).toMatchObject({line:8,startLine:2,outdated:{line:8,startLine:2,revision:1}});
});
it("maps submitted comments locally without changing their GitHub identity", async () => {
 const c=setup(); writeComments(key,[{...c,status:"submitted",submittedAt:"2026-01-01",githubCommentId:42}],root);
 await reanchorComments(key,root,{path:"/stub"},git);
 expect(readComments(key,root)[0]).toMatchObject({line:5,revision:2,status:"submitted",githubCommentId:42});
});
it("maps LEFT comments through a changed diff base", async () => {
 const c=setup(); writeComments(key,[{...c,side:"LEFT"}],root);
 const files=parseDiff("diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-a\n+b\n");
 appendEvents(key,[{type:"revision-added",revision:3,baseSha:"base3",headSha:"head3",mergeBase:"mb3",baseOnly:false,files:toRevisionFiles(files)}],root);
 const pairs: string[][]=[];
 await reanchorComments(key,root,{path:"/stub"},async (repo,args)=> {
  if(args.includes("-U0")) pairs.push(args);
  return git(repo,args);
 });
 expect(pairs[0]).toEqual(expect.arrayContaining(["mb1","mb3"]));
 expect(readComments(key,root)[0]).toMatchObject({line:5,revision:3});
});
