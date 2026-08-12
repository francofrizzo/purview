import { describe, expect, it } from "vitest";
import { buildRows, buildSplitRows, hunkLabel } from "./diffModel";
import type { Hunk } from "../api/types";

let seq = 0;
function hunk(lines: string[]): Hunk {
  return {
    id: `h${seq++}`,
    file: "a.ts",
    oldStart: 1,
    oldLines: lines.filter((l) => !l.startsWith("+")).length,
    newStart: 1,
    newLines: lines.filter((l) => !l.startsWith("-")).length,
    header: "",
    lines,
  } as Hunk;
}

describe("hunkLabel", () => {
  const base = { ...hunk([" a"]), oldStart: 18, oldLines: 10, newStart: 18, newLines: 26 };

  it("prints the range once when header is only the section heading", () => {
    expect(hunkLabel({ ...base, header: "export class ChargeService {" })).toBe(
      "@@ -18,10 +18,26 @@ export class ChargeService {",
    );
  });

  it("does not repeat the range when header carries the whole @@ line", () => {
    expect(
      hunkLabel({ ...base, header: "@@ -18,10 +18,26 @@ export class ChargeService {" }),
    ).toBe("@@ -18,10 +18,26 @@ export class ChargeService {");
  });

  it("drops a bare @@ line with no heading", () => {
    expect(hunkLabel({ ...base, header: "@@ -0,0 +1,14 @@", oldStart: 0, oldLines: 0, newStart: 1, newLines: 14 })).toBe(
      "@@ -0,0 +1,14 @@",
    );
  });

  it("handles an empty header", () => {
    expect(hunkLabel({ ...base, header: "" })).toBe("@@ -18,10 +18,26 @@");
  });
});

describe("buildSplitRows", () => {
  it("puts context lines on both sides", () => {
    const rows = buildSplitRows(hunk([" a", " b"]), "");
    expect(rows).toHaveLength(2);
    expect(rows[0].left?.row.content).toBe("a");
    expect(rows[0].right?.row.content).toBe("a");
    expect(rows[0].left?.row.oldNumber).toBe(1);
    expect(rows[0].right?.row.newNumber).toBe(1);
  });

  it("zips a del/add run positionally", () => {
    const rows = buildSplitRows(hunk([" x", "-one", "-two", "+ONE", "+TWO", " y"]), "");
    expect(rows.map((r) => [r.left?.row.content ?? null, r.right?.row.content ?? null])).toEqual([
      ["x", "x"],
      ["one", "ONE"],
      ["two", "TWO"],
      ["y", "y"],
    ]);
  });

  it("pads the shorter side with filler cells", () => {
    const rows = buildSplitRows(hunk(["-a", "+A", "+B", "+C"]), "");
    expect(rows.map((r) => [r.left?.row.content ?? null, r.right?.row.content ?? null])).toEqual([
      ["a", "A"],
      [null, "B"],
      [null, "C"],
    ]);
  });

  it("handles pure additions and pure deletions", () => {
    const adds = buildSplitRows(hunk([" a", "+b"]), "");
    expect(adds[1].left).toBeNull();
    expect(adds[1].right?.row.content).toBe("b");

    const dels = buildSplitRows(hunk([" a", "-b"]), "");
    expect(dels[1].right).toBeNull();
    expect(dels[1].left?.row.content).toBe("b");
  });

  it("indexes back into the unified rows (shiki token lookup)", () => {
    const h = hunk([" x", "-one", "-two", "+ONE", " y"]);
    const unified = buildRows(h, "");
    const split = buildSplitRows(h, "");
    for (const pair of split) {
      for (const cell of [pair.left, pair.right]) {
        if (cell) expect(unified[cell.index]).toBe(cell.row);
      }
    }
  });

  it("reuses the word-level intra ranges from the unified rows", () => {
    const rows = buildSplitRows(hunk(["-const a = 1;", "+const a = 2;"]), "");
    const left = rows[0].left!.row;
    const right = rows[0].right!.row;
    expect(left.intra?.length).toBeGreaterThan(0);
    expect(right.intra?.length).toBeGreaterThan(0);
    expect(left.content.slice(left.intra![0].start, left.intra![0].end)).toBe("1");
    expect(right.content.slice(right.intra![0].start, right.intra![0].end)).toBe("2");
  });
});
