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
 * Build a PR state dir directly through @reviewer/core's store functions
 * (writeMeta / appendEvents / writeRevision), the way the SPEC describes
 * revisions/state being assembled — no network, no `gh`.
 */
export function buildFixture(root: string): { key: PrKey; hunkIds: string[] } {
  const files = parseDiff(REV1_PATCH);
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
    REV1_PATCH,
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
