import { describe, expect, it } from "vitest";
import { fileGaps, revealGap } from "./contextGaps";

const h = (id: string, oldStart: number, oldLines: number, newStart: number, newLines: number) => ({
  id,
  oldStart,
  oldLines,
  newStart,
  newLines,
});

describe("fileGaps", () => {
  // Hunk a: old 10-15 -> new 10-17 (+2 lines); hunk b: old 40-44 -> new 42-46.
  const gaps = fileGaps("f.ts", [h("b", 40, 5, 42, 5), h("a", 10, 6, 10, 8)]);

  it("finds the gaps before, between and after the hunks, in order", () => {
    expect(gaps.map((g) => [g.key, g.from, g.to])).toEqual([
      ["f.ts:^", 1, 9],
      ["f.ts:a", 18, 41],
      ["f.ts:b", 47, null],
    ]);
  });

  it("maps new-side numbers to old ones with the running shift", () => {
    expect(gaps[0].shift).toBe(0);
    // new 18 is old 16: two lines were added in hunk a
    expect(gaps[1].shift).toBe(2);
    expect(gaps[2].shift).toBe(2);
    expect(gaps[1].prevHunkId).toBe("a");
    expect(gaps[1].nextHunkId).toBe("b");
  });

  it("drops empty gaps and reads an empty side as 'after this line'", () => {
    // pure addition at the top of a file: nothing before it
    expect(fileGaps("n.ts", [h("x", 0, 0, 1, 14)]).map((g) => g.key)).toEqual(["n.ts:x"]);
    // pure deletion after new line 4: the gap before ends at 4, after starts at 5
    const del = fileGaps("d.ts", [h("y", 5, 2, 4, 0)]);
    expect(del.map((g) => [g.from, g.to, g.shift])).toEqual([
      [1, 4, 0],
      [5, null, -2],
    ]);
  });
});

describe("revealGap", () => {
  const gap = { key: "k", path: "p", prevHunkId: "a", nextHunkId: "b", from: 18, to: 41, shift: 2 };

  it("shows nothing and counts everything hidden when closed", () => {
    expect(revealGap(gap, { top: 0, bottom: 0 }, null)).toEqual({ top: null, bottom: null, hidden: 24 });
  });

  it("opens from either end and never overlaps", () => {
    expect(revealGap(gap, { top: 20, bottom: 0 }, null)).toEqual({ top: [18, 37], bottom: null, hidden: 4 });
    expect(revealGap(gap, { top: 20, bottom: 20 }, null)).toEqual({ top: [18, 37], bottom: [38, 41], hidden: 0 });
  });

  it("needs the file length to lay out the open-ended last gap", () => {
    const last = { ...gap, to: null };
    expect(revealGap(last, { top: 20, bottom: 0 }, null).hidden).toBeNull();
    expect(revealGap(last, { top: 20, bottom: 0 }, 30)).toEqual({ top: [18, 30], bottom: null, hidden: 0 });
    expect(revealGap(last, { top: 0, bottom: 0 }, 17).hidden).toBe(0);
  });
});
