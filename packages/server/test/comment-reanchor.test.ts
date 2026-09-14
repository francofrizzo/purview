import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendEvents, parseDiff, toRevisionFiles, writeRevision, type PrKey } from "@reviewer/core";
import {
  addComment,
  findAnchoringHunk,
  reanchorDraftComments,
  readComments,
  unanchoredDraftLineComments,
} from "../src/comments.js";
import { buildFixture, key } from "./fixtures.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-reanchor-test-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Appends a revision directly through core's store functions, like buildFixture does. */
function addRevision(
  key: PrKey,
  revision: number,
  patch: string,
  shas: { baseSha?: string; headSha?: string; mergeBase?: string } = {},
): void {
  const files = parseDiff(patch);
  writeRevision(key, revision, patch, files, shas, root);
  appendEvents(
    key,
    [
      {
        type: "revision-added",
        revision,
        baseSha: shas.baseSha ?? `base${revision}`,
        headSha: shas.headSha ?? `head${revision}`,
        mergeBase: shas.mergeBase ?? `mb${revision}`,
        baseOnly: false,
        files: toRevisionFiles(files),
      },
    ],
    root,
  );
}

/* --------------------------------------------------------------- fixtures */

// Revision 1: two hunks in src/foo.ts, same shape as fixtures.ts's REV1_PATCH
// — a content edit near the top (RIGHT-side target) and one further down
// (LEFT-side target).
const REV1 = `diff --git a/src/foo.ts b/src/foo.ts
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

// Revision 2: the PR grew a bunch of lines above src/foo.ts's changes, so
// both hunks slide down by 75 — but their content (added/removed lines) is
// byte-identical, so their hunk ids are unchanged (see hunk-id.ts).
const REV2_SLID = `diff --git a/src/foo.ts b/src/foo.ts
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

// Revision 2 variant where the top hunk (the one the draft is anchored to)
// is gone entirely from the diff — reverted, or overtaken by something else
// upstream — while the other hunk carries over unchanged. There is no hunk
// anywhere in this revision whose id matches the one the draft used to sit
// on, so there is nothing safe to re-anchor to.
const REV2_HUNK_GONE = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..4444444 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,3 +10,3 @@
 line10
-old11
+new11
 line12
`;

// Revision 2 variant where src/foo.ts was renamed to src/bar.ts, content
// unchanged — hunk ids recompute under the new path via the rename-aware
// path in migration.ts, so this exercises the `toFile` branch.
const REV2_RENAMED = `diff --git a/src/foo.ts b/src/bar.ts
similarity index 90%
rename from src/foo.ts
rename to src/bar.ts
index 1111111..5555555 100644
--- a/src/foo.ts
+++ b/src/bar.ts
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

/* -------------------------------------------------------------------- tests */

describe("reanchorDraftComments", () => {
  it("moves a RIGHT-side draft's line when its hunk slides by content-identical id", () => {
    buildFixture(root, REV1);
    // new2 sits at newStart(1)+1 = line 2.
    const draft = addComment(key, { file: "src/foo.ts", line: 2, side: "RIGHT", body: "why?" }, root);

    addRevision(key, 2, REV2_SLID, { headSha: "head2" });

    const moves = reanchorDraftComments(key, root);
    expect(moves).toEqual([
      { id: draft.id, file: "src/foo.ts", fromLine: 2, toLine: 77, toFile: undefined },
    ]);

    const [updated] = readComments(key, root);
    expect(updated.file).toBe("src/foo.ts");
    expect(updated.line).toBe(77);
  });

  it("moves a LEFT-side draft the same way, using oldStart", () => {
    buildFixture(root, REV1);
    // old11 sits at oldStart(10)+1 = line 11.
    const draft = addComment(key, { file: "src/foo.ts", line: 11, side: "LEFT", body: "removed?" }, root);

    addRevision(key, 2, REV2_SLID, { headSha: "head2" });

    const moves = reanchorDraftComments(key, root);
    expect(moves).toEqual([
      { id: draft.id, file: "src/foo.ts", fromLine: 11, toLine: 86, toFile: undefined },
    ]);
    expect(readComments(key, root)[0].line).toBe(86);
  });

  it("follows a renamed file, updating both file and line", () => {
    buildFixture(root, REV1);
    const draft = addComment(key, { file: "src/foo.ts", line: 2, side: "RIGHT", body: "still here?" }, root);

    addRevision(key, 2, REV2_RENAMED, { headSha: "head2" });

    const moves = reanchorDraftComments(key, root);
    expect(moves).toEqual([
      { id: draft.id, file: "src/foo.ts", fromLine: 2, toLine: 2, toFile: "src/bar.ts" },
    ]);
    const [updated] = readComments(key, root);
    expect(updated.file).toBe("src/bar.ts");
    expect(updated.line).toBe(2);
  });

  it("leaves an unanchorable draft untouched when its hunk is gone from the current diff", () => {
    buildFixture(root, REV1);
    const draft = addComment(key, { file: "src/foo.ts", line: 2, side: "RIGHT", body: "stale" }, root);

    addRevision(key, 2, REV2_HUNK_GONE, { headSha: "head2" });

    const moves = reanchorDraftComments(key, root);
    expect(moves).toEqual([]);
    const [updated] = readComments(key, root);
    expect(updated.file).toBe("src/foo.ts");
    expect(updated.line).toBe(2);
    // ...and it's correctly flagged as outside the current diff.
    expect(unanchoredDraftLineComments(key, root).map((c) => c.id)).toEqual([draft.id]);
  });

  it("leaves a comment already anchored in the current revision alone", () => {
    buildFixture(root, REV1);
    addComment(key, { file: "src/foo.ts", line: 2, side: "RIGHT", body: "fine" }, root);
    expect(reanchorDraftComments(key, root)).toEqual([]);
  });

  it("is idempotent — a second call after a successful move is a no-op", () => {
    buildFixture(root, REV1);
    addComment(key, { file: "src/foo.ts", line: 2, side: "RIGHT", body: "why?" }, root);
    addRevision(key, 2, REV2_SLID, { headSha: "head2" });

    const first = reanchorDraftComments(key, root);
    expect(first.length).toBe(1);
    const second = reanchorDraftComments(key, root);
    expect(second).toEqual([]);
  });

  it("does not touch pushed/submitted comments or file-level comments", () => {
    buildFixture(root, REV1);
    addComment(key, { file: "src/foo.ts", body: "whole file" }, root); // file-level
    addRevision(key, 2, REV2_SLID, { headSha: "head2" });
    // Only the file-level draft exists; nothing anchorable to move.
    expect(reanchorDraftComments(key, root)).toEqual([]);
  });
});

describe("findAnchoringHunk", () => {
  it("skips a hunk with newLines === 0 on the RIGHT side (pure deletion)", () => {
    const files = parseDiff(`diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +0,0 @@
-a
-b
`);
    expect(findAnchoringHunk(files, "src/foo.ts", 1, "RIGHT")).toBeUndefined();
    expect(findAnchoringHunk(files, "src/foo.ts", 1, "LEFT")).toBeDefined();
  });
});
