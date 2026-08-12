import {
  appendEvent,
  appendEvents,
  parseDiff,
  toRevisionFiles,
  writeMeta,
  writeRevision,
  type PrKey,
} from "@reviewer/core";

export const key: PrKey = {
  host: "github.com",
  owner: "acme",
  repo: "widgets",
  number: 7,
};

export const REV1_PATCH = `diff --git a/src/foo.ts b/src/foo.ts
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

export const REV2_PATCH = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..3333333 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@
 line1
-old2
+newer2
 line3
@@ -10,3 +10,3 @@
 line10
-old11
+new11
 line12
`;

/**
 * A wide first hunk, so that editing a single line still clears core's fuzzy
 * threshold (Jaccard is over the *set* of added+removed lines, so a two-line
 * hunk with one line edited scores only 0.33 and would be archived instead).
 */
const bigHunk = (line5: string) => `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,8 +1,8 @@
 line1
-old2
-old3
-old4
-old5
+new2
+new3
+new4
+${line5}
 line9
@@ -20,3 +20,3 @@
 line20
-old21
+new21
 line22
`;

/** revision 1: the reader views the wide hunk here. */
export const DOD_REV1 = bigHunk("new5");
/** revision 2: one line of that hunk changes -> fuzzy match, changedSinceViewed. */
export const DOD_REV2 = bigHunk("newer5");
/**
 * revision 3: identical content to REV2, only the shas move — so the hunk
 * carries over *identically* here. Diffing r3 against r2 would show nothing,
 * which is what makes this the regression case for baselining diff-of-diffs
 * on the revision the reader actually viewed.
 */
export const DOD_REV3 = bigHunk("newer5");

/**
 * Build a PR state dir directly through @reviewer/core's store functions
 * (writeMeta / appendEvents / writeRevision), the way the SPEC describes
 * revisions/state being assembled — no network, no `gh`.
 */
export function buildFixture(
  root: string,
  patch: string = REV1_PATCH,
): { key: PrKey; hunkIds: string[] } {
  const files = parseDiff(patch);
  const hunkIds = files.flatMap((f) => f.hunks.map((h) => h.id));

  writeMeta(
    key,
    {
      host: key.host,
      owner: key.owner,
      repo: key.repo,
      number: key.number,
      url: `https://github.com/${key.owner}/${key.repo}/pull/${key.number}`,
      title: "Add widgets",
      createdAt: new Date().toISOString(),
    },
    root,
  );
  appendEvent(
    key,
    {
      type: "pr-initialized",
      host: key.host,
      owner: key.owner,
      repo: key.repo,
      number: key.number,
      url: `https://github.com/${key.owner}/${key.repo}/pull/${key.number}`,
      title: "Add widgets",
    },
    root,
  );
  writeRevision(
    key,
    1,
    patch,
    files,
    { baseSha: "base1", headSha: "head1", mergeBase: "mb1" },
    root,
  );
  appendEvents(
    key,
    [
      {
        type: "revision-added",
        revision: 1,
        baseSha: "base1",
        headSha: "head1",
        mergeBase: "mb1",
        baseOnly: false,
        files: toRevisionFiles(files),
      },
      {
        type: "analysis-set",
        revision: 1,
        summary: "Adds widgets.",
        units: [
          {
            id: "unit-1",
            title: "Widget logic",
            summary: "Core widget behavior.",
            kind: "core-logic",
            attention: "must-read",
            attentionWhy: "New behavior",
            riskFlags: [],
            hunkIds,
            order: 1,
          },
        ],
        unassigned: [],
      },
    ],
    root,
  );

  return { key, hunkIds };
}
