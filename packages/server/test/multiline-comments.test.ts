import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendEvents, parseDiff, setGhRunner, toRevisionFiles, writeRevision, type PrKey } from "@reviewer/core";
import { createApp } from "../src/app.js";
import {
  NewCommentSchema,
  addComment,
  commentPosition,
  findAnchoringHunk,
  reanchorDraftComments,
  readComments,
  unanchoredDraftLineComments,
  updateCommentPosition,
  writeComments,
} from "../src/comments.js";
import { linkLocal, normalizeThreads, type RemoteThread } from "../src/github-threads.js";
import { buildFixture, key } from "./fixtures.js";
import { fakeGh, type FakeGh } from "./fake-gh.js";

/**
 * Multi-line comments: a comment covering `startLine..line`, GitHub's own
 * model. The fixture's src/foo.ts has two hunks (lines 1-3 and 10-12 on
 * either side), so 1-3 is a legal range and 2-11 straddles the two.
 */

const encodedKey = encodeURIComponent(`${key.host}/${key.owner}/${key.repo}/${key.number}`);

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-multiline-test-"));
  buildFixture(root);
});

afterEach(() => {
  setGhRunner(null);
  fs.rmSync(root, { recursive: true, force: true });
});

const json = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/* ------------------------------------------------------------------ schema */

describe("NewCommentSchema with a range", () => {
  it("accepts startLine < line and fills startSide from side", () => {
    const c = NewCommentSchema.parse({ file: "src/foo.ts", line: 3, side: "RIGHT", startLine: 1, body: "x" });
    expect(c).toMatchObject({ subjectType: "line", line: 3, startLine: 1, startSide: "RIGHT" });
  });

  it("reads a one-line range as a single-line comment", () => {
    const c = NewCommentSchema.parse({ file: "src/foo.ts", line: 3, side: "RIGHT", startLine: 3, body: "x" });
    expect(c.startLine).toBeUndefined();
    expect(c.startSide).toBeUndefined();
  });

  it("rejects a start after the line, a start on the other side, and a range on a file comment", () => {
    expect(NewCommentSchema.safeParse({ file: "f", line: 3, side: "RIGHT", startLine: 5, body: "x" }).success).toBe(false);
    expect(
      NewCommentSchema.safeParse({ file: "f", line: 3, side: "RIGHT", startLine: 1, startSide: "LEFT", body: "x" }).success,
    ).toBe(false);
    expect(NewCommentSchema.safeParse({ file: "f", subjectType: "file", startLine: 1, body: "x" }).success).toBe(false);
  });

  it("stores and reloads the range; comments without one still load", () => {
    const created = addComment(key, { file: "src/foo.ts", line: 3, side: "RIGHT", startLine: 1, body: "range" }, root);
    expect(created).toMatchObject({ startLine: 1, startSide: "RIGHT", line: 3 });
    addComment(key, { file: "src/foo.ts", line: 2, side: "RIGHT", body: "single" }, root);
    const stored = readComments(key, root);
    expect(stored.map((c) => c.startLine)).toEqual([1, undefined]);
    expect(commentPosition(stored[0])).toBe("src/foo.ts:1–3");
    expect(commentPosition(stored[1])).toBe("src/foo.ts:2");
  });

  it("reads a stored range that does not precede its line as a single-line comment", () => {
    const file = path.join(root, key.host, key.owner, key.repo, String(key.number), "comments.json");
    fs.writeFileSync(
      file,
      JSON.stringify([
        { id: "bad", file: "src/foo.ts", line: 2, side: "RIGHT", startLine: 4, body: "x", createdAt: "now", status: "draft" },
      ]),
    );
    const [c] = readComments(key, root);
    expect(c.startLine).toBeUndefined();
    expect(c.startSide).toBeUndefined();
  });
});

/* -------------------------------------------------------------- anchoring */

describe("findAnchoringHunk with a range", () => {
  it("needs one hunk to hold both ends", () => {
    const diff = parseDiff(FIXTURE_DIFF);
    expect(findAnchoringHunk(diff, "src/foo.ts", 3, "RIGHT", 1)).toBeDefined();
    expect(findAnchoringHunk(diff, "src/foo.ts", 11, "RIGHT", 2)).toBeUndefined();
    expect(findAnchoringHunk(diff, "src/foo.ts", 12, "LEFT", 10)).toBeDefined();
  });
});

const FIXTURE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@
 line1
-old2
+new2
 line3
@@ -10,3 +10,3 @@
 line10
-old11
+new11
 line12
`;

/* ------------------------------------------------------------------ routes */

describe("POST /api/prs/:key/comments with a range (CLI actor)", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    app = createApp({ stateDir: root, webDist: path.join(root, "__no-web-dist__") });
  });
  const cli = (body: unknown) => ({
    ...json(body),
    headers: { "Content-Type": "application/json", "X-Purview-Actor": "you" },
  });

  it("accepts a range inside one hunk", async () => {
    const res = await app.request(`/api/prs/${encodedKey}/comments`, cli({ file: "src/foo.ts", line: 3, startLine: 1, side: "RIGHT", body: "r" }));
    expect(res.status).toBe(201);
    expect((await res.json()).comment).toMatchObject({ startLine: 1, line: 3, startSide: "RIGHT" });
  });

  it("refuses a range that straddles two hunks as outside the diff", async () => {
    const res = await app.request(`/api/prs/${encodedKey}/comments`, cli({ file: "src/foo.ts", line: 11, startLine: 2, side: "RIGHT", body: "r" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("comment_outside_diff");
    expect(body.detail).toMatch(/2–11/);
  });

  it("moves a range as a whole on PATCH and refuses a shifted range that leaves its hunk", async () => {
    const created = addComment(key, { file: "src/foo.ts", line: 2, side: "RIGHT", startLine: 1, body: "r" }, root);
    const ok = await app.request(`/api/prs/${encodedKey}/comments/${created.id}`, { ...json({ line: 3 }), method: "PATCH" });
    expect(ok.status).toBe(200);
    expect((await ok.json()).comment).toMatchObject({ startLine: 2, line: 3 });
    // 9–10 would start just above the second hunk (lines 10-12).
    const bad = await app.request(`/api/prs/${encodedKey}/comments/${created.id}`, { ...json({ line: 10 }), method: "PATCH" });
    expect(bad.status).toBe(422);
    const detail = await bad.json();
    expect(detail.error).toBe("comment_outside_diff");
    expect(detail.detail).toMatch(/9–10/);
  });
});

/* -------------------------------------------------------------------- push */

describe("pushing a multi-line comment", () => {
  let app: ReturnType<typeof createApp>;
  let gh: FakeGh;
  beforeEach(() => {
    app = createApp({ stateDir: root, webDist: path.join(root, "__no-web-dist__") });
    gh = fakeGh();
    gh.install();
  });
  const sync = () => app.request(`/api/prs/${encodedKey}/sync`, { method: "POST" });

  it("sends start_line/start_side in the REST create payload and backfills the right ids", async () => {
    const range = addComment(key, { file: "src/foo.ts", line: 3, side: "RIGHT", startLine: 1, body: "range" }, root);
    const single = addComment(key, { file: "src/foo.ts", line: 3, side: "RIGHT", body: "single" }, root);
    const res = await sync();
    expect(res.status).toBe(200);
    const remote = gh.reviews[0].comments;
    expect(remote.map((c) => [c.line, c.start_line, c.start_side, c.body])).toEqual([
      [3, 1, "RIGHT", "range"],
      [3, undefined, undefined, "single"],
    ]);
    // Same end line, different start: each draft got its own remote id.
    const stored = readComments(key, root);
    expect(stored.find((c) => c.id === range.id)!.githubCommentId).toBe(remote[0].id);
    expect(stored.find((c) => c.id === single.id)!.githubCommentId).toBe(remote[1].id);
  });

  it("passes startLine/startSide to addPullRequestReviewThread when appending", async () => {
    addComment(key, { file: "src/foo.ts", line: 2, side: "RIGHT", body: "first" }, root);
    await sync();
    addComment(key, { file: "src/foo.ts", line: 12, side: "LEFT", startLine: 10, body: "old range" }, root);
    const res = await sync();
    expect(res.status).toBe(200);
    const call = gh.calls.find((c) => c[1] === "graphql" && c.some((a) => a.includes("addPullRequestReviewThread")))!;
    expect(call).toContain("startLine=10");
    expect(call).toContain("startSide=LEFT");
    expect(call).toContain("line=12");
    const appended = gh.reviews[0].comments.find((c) => c.body === "old range")!;
    expect(appended).toMatchObject({ line: 12, start_line: 10, start_side: "LEFT" });
  });

  it("fails fast on a range outside the diff, naming the range", async () => {
    writeComments(
      key,
      [
        {
          id: "straddle",
          file: "src/foo.ts",
          subjectType: "line",
          line: 11,
          side: "RIGHT",
          startLine: 2,
          startSide: "RIGHT",
          body: "spans two hunks",
          createdAt: new Date().toISOString(),
          status: "draft",
        },
      ],
      root,
    );
    const res = await sync();
    const { comments } = await res.json();
    expect(comments.ok).toBe(false);
    expect(comments.errorCode).toBe("comment_outside_diff");
    expect(comments.error).toMatch(/src\/foo\.ts:2–11/);
    // The pre-flight check runs before anything reaches GitHub's review API.
    expect(gh.reviews).toEqual([]);
    expect(gh.calls.some((c) => c.some((a) => a.includes("addPullRequestReviewThread")))).toBe(false);
  });
});

/* ------------------------------------------------------------ re-anchoring */

function addRevision(key: PrKey, revision: number, patch: string): void {
  const files = parseDiff(patch);
  writeRevision(key, revision, patch, files, {}, root);
  appendEvents(
    key,
    [
      {
        type: "revision-added",
        revision,
        baseSha: `base${revision}`,
        headSha: `head${revision}`,
        mergeBase: `mb${revision}`,
        baseOnly: false,
        files: toRevisionFiles(files),
      },
    ],
    root,
  );
}

// The fixture's top hunk, slid down by 75 lines with identical content.
const SLID = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..3333333 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -76,3 +76,3 @@
 line1
-old2
+new2
 line3
@@ -85,3 +85,3 @@
 line10
-old11
+new11
 line12
`;

// The top hunk shrank: it now holds only new-side lines 1-2, so a range
// that used to end on line 3 has lost one end.
const SHRUNK = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..4444444 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,2 @@
 line1
-old2
+new2
@@ -10,3 +10,3 @@
 line10
-old11
+new11
 line12
`;

describe("re-anchoring a multi-line comment", () => {
  it("slides both ends when its hunk slides", () => {
    const c = addComment(key, { file: "src/foo.ts", line: 3, side: "RIGHT", startLine: 1, body: "r" }, root);
    addRevision(key, 2, SLID);
    const moves = reanchorDraftComments(key, root);
    expect(moves).toEqual([
      { id: c.id, file: "src/foo.ts", fromLine: 3, toLine: 78, toFile: undefined, fromStartLine: 1, toStartLine: 76 },
    ]);
    const [stored] = readComments(key, root);
    expect(stored).toMatchObject({ startLine: 76, line: 78, startSide: "RIGHT" });
    expect(unanchoredDraftLineComments(key, root)).toEqual([]);
  });

  it("leaves a range alone — and reports it outside the diff — when only one end survives", () => {
    const c = addComment(key, { file: "src/foo.ts", line: 3, side: "RIGHT", startLine: 1, body: "r" }, root);
    addRevision(key, 2, SHRUNK);
    expect(reanchorDraftComments(key, root)).toEqual([]);
    const [stored] = readComments(key, root);
    // Not shrunk to 1..2: the reader decides what the comment now means.
    expect(stored).toMatchObject({ id: c.id, startLine: 1, line: 3 });
    expect(unanchoredDraftLineComments(key, root).map((x) => x.id)).toEqual([c.id]);
  });

  it("updateCommentPosition shifts the range start with the line", () => {
    const c = addComment(key, { file: "src/foo.ts", line: 3, side: "RIGHT", startLine: 1, body: "r" }, root);
    const moved = updateCommentPosition(key, c.id, { line: 12 }, root);
    expect(moved.comment).toMatchObject({ startLine: 10, line: 12 });
  });
});

/* -------------------------------------------------------- GitHub threads */

function rawThread(over: Record<string, unknown>) {
  return {
    id: "PRRT_1",
    path: "src/foo.ts",
    line: 3,
    originalLine: 3,
    startLine: 1,
    originalStartLine: 1,
    startDiffSide: "RIGHT",
    diffSide: "RIGHT",
    subjectType: "LINE",
    isResolved: false,
    isOutdated: false,
    viewerCanResolve: true,
    viewerCanUnresolve: false,
    viewerCanReply: true,
    comments: {
      nodes: [
        {
          id: "PRRC_1",
          databaseId: 1,
          body: "range",
          createdAt: "2026-01-01T00:00:00Z",
          url: "u",
          author: { __typename: "User", login: "me" },
          pullRequestReview: { state: "SUBMITTED" },
        },
      ],
    },
    ...over,
  };
}

describe("imported threads with a range", () => {
  it("normalizes startLine, originalStartLine and startSide", () => {
    const [t] = normalizeThreads([rawThread({})], { viewerLogin: "me" });
    expect(t).toMatchObject({ line: 3, startLine: 1, originalStartLine: 1, startSide: "RIGHT", side: "RIGHT" });
    const [single] = normalizeThreads([rawThread({ startLine: null, originalStartLine: null, startDiffSide: null })], {
      viewerLogin: "me",
    });
    expect(single).toMatchObject({ startLine: null, originalStartLine: null, startSide: null });
  });

  it("links a pushed local range only to a thread with the same range", () => {
    const [t] = normalizeThreads([rawThread({})], { viewerLogin: "me" });
    const single = { id: "l1", file: "src/foo.ts", line: 3, body: "range", status: "pushed" as const, subjectType: "line" as const };
    const range = { ...single, id: "l2", startLine: 1 };
    expect(linkLocal([t], [single])[0].comments[0].localId).toBeUndefined();
    expect(linkLocal([t], [range])[0].comments[0].localId).toBe("l2");
    // An outdated thread keeps only the original range.
    const outdated: RemoteThread = { ...t, line: null, startLine: null, isOutdated: true };
    expect(linkLocal([outdated], [range])[0].comments[0].localId).toBe("l2");
    // A cache from before ranges were fetched: a single-line local still links.
    const legacy = { ...t, startLine: null, originalStartLine: undefined, startSide: undefined } as unknown as RemoteThread;
    expect(linkLocal([legacy], [single])[0].comments[0].localId).toBe("l1");
  });
});
