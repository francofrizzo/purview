import { describe, expect, it } from "vitest";
import { hunkBodies } from "./hunkBodies";
import type { Hunk } from "../api/types";

const hunk = (file: string, oldStart: number, oldLines: number, newStart: number, newLines: number): Hunk =>
  ({ id: file, file, oldStart, oldLines, newStart, newLines, header: "" });

describe("wire hunk bodies", () => {
  it("preserves markers, blank lines, short headers, renames and deleted paths", () => {
    const diff = 'diff --git a/old b/new\n--- a/old\n+++ b/new\n@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n\ndiff --git a/gone b/gone\n--- a/gone\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n';
    const body = hunkBodies(diff);
    expect(body(hunk("new", 1, 1, 1, 1))).toEqual(["-old", "+new", "\\ No newline at end of file", ""]);
    expect(body(hunk("gone", 1, 1, 0, 0))).toEqual(["-gone"]);
    expect(body(hunk("absent", 1, 1, 1, 1))).toBeUndefined();
  });

  it("decodes quoted paths and keeps multiple hunks separate", () => {
    const body = hunkBodies('diff --git "a/a\\tb" "b/a\\tb"\n--- "a/a\\tb"\n+++ "b/a\\tb"\n@@ -0,0 +1,1 @@\n+one\n@@ -9,1 +10,1 @@\n-- content\n++ content\n');
    expect(body(hunk("a\tb", 0, 0, 1, 1))).toEqual(["+one"]);
    expect(body(hunk("a\tb", 9, 1, 10, 1))).toEqual(["-- content", "++ content"]);
  });
});

it("reconstructs all fixture content from the slim response", async () => {
  const { mockDetail } = await import("../mocks/fixture");
  const { hydrateFiles } = await import("./hunkBodies");
  const files = mockDetail.files.files;
  const slim = files.map((f) => ({ ...f, hunks: f.hunks.map(({ lines, addedLines, removedLines, ...h }) => h) }));
  const hydrated = hydrateFiles(slim, mockDetail.diff);
  for (let i = 0; i < files.length; i++) {
    for (let j = 0; j < files[i].hunks.length; j++) {
      const original = files[i].hunks[j];
      expect(hydrated[i].hunks[j].lines).toEqual(original.lines);
      if (original.addedLines) expect(hydrated[i].hunks[j].addedLines).toEqual(original.addedLines);
      if (original.removedLines) expect(hydrated[i].hunks[j].removedLines).toEqual(original.removedLines);
    }
  }
});
