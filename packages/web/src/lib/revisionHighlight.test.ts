import { describe, expect, it } from "vitest";
import type { RevisionLineChanges } from "../api/types";
import {
  buildHighlight,
  highlightTally,
  hunkChangedLabel,
  markedRowIndexes,
  toMultiset,
} from "./revisionHighlight";

describe("markedRowIndexes", () => {
  const rows = [" ctx", "-old", "+first", "+  }", " tail", "+  }", "+  }"];

  it("marks rows whose raw text (prefix included) was introduced", () => {
    expect([...markedRowIndexes(rows, toMultiset(["+first"]))]).toEqual([2]);
  });

  it("matches on the prefix too: a context line is not the added one", () => {
    expect([...markedRowIndexes(rows, toMultiset(["+ctx", " tail"]))]).toEqual([4]);
  });

  it("consumes matches so duplicates mark only as many as were introduced", () => {
    expect([...markedRowIndexes(rows, toMultiset(["+  }"]))]).toEqual([3]);
    expect([...markedRowIndexes(rows, toMultiset(["+  }", "+  }"]))]).toEqual([3, 5]);
    expect([...markedRowIndexes(rows, toMultiset(["+  }", "+  }", "+  }", "+  }"]))]).toEqual([3, 5, 6]);
  });

  it("marks removed lines when they were introduced", () => {
    expect([...markedRowIndexes(rows, toMultiset(["-old"]))]).toEqual([1]);
  });

  it("marks nothing for an empty multiset", () => {
    expect(markedRowIndexes(rows, new Map()).size).toBe(0);
  });
});

describe("buildHighlight", () => {
  const data: RevisionLineChanges = {
    revision: 5,
    currentRevision: 7,
    hunks: [
      { currentHunkId: "a", originHunkId: "a0", file: "a.ts", status: "fuzzy", introduced: ["+x", "+x"], droppedCount: 3, exactAtCurrent: false },
      { currentHunkId: "b", originHunkId: "b", file: "b.ts", status: "new", introduced: ["+y"], droppedCount: 0, exactAtCurrent: true },
    ],
    goneCount: 2,
    gone: [
      { originHunkId: "g1", lastHunkId: "g1", file: "g.ts", goneAtRevision: 6, unitId: "u1" },
      { originHunkId: "g2", lastHunkId: "g2", file: "g.ts", goneAtRevision: 6, unitId: "u2" },
    ],
  };

  it("keeps only the scope's hunks and its own gone hunks", () => {
    const h = buildHighlight(data, { hunkIds: ["a"], unitId: "u1" });
    expect([...h.byHunk.keys()]).toEqual(["a"]);
    expect(h.byHunk.get("a")!.introduced.get("+x")).toBe(2);
    expect(h.goneCount).toBe(1);
    expect(highlightTally(h)).toEqual({ lines: 2, hunks: 1 });
  });

  it("labels the hunk header, with removed lines and the inexact tooltip", () => {
    const h = buildHighlight(data);
    expect(hunkChangedLabel(5, h.byHunk.get("a")!)).toEqual({
      text: "changed in r5 · 3 lines removed",
      title: "Changed again after r5; lines matched by content.",
    });
    expect(hunkChangedLabel(5, h.byHunk.get("b")!).text).toBe("changed in r5");
  });
});
