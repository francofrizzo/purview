import { describe, expect, it } from "vitest";
import { buildRows, buildSplitRows, heartRowIndices, hunkLabel, orderUnitHunks, unitProgress } from "./diffModel";
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

  it("records which line each row's intra ranges were computed against", () => {
    // A moved-out block zipped with the re-export under it: the pair is
    // positional, so the pane needs to know who paired with whom to drop the
    // ranges once it learns one side is a move.
    const rows = buildRows(hunk(["-export function formatReport(report: Report) {", "-}", '+export { formatReport } from "./report";']), "");
    expect(rows[0].intra?.length).toBeGreaterThan(0);
    expect(rows[0].pairedWith).toBe(2);
    expect(rows[2].pairedWith).toBe(0);
    // the unpaired second removal, and a pair too different to highlight
    expect(rows[1].pairedWith).toBeUndefined();
    const far = buildRows(hunk(["-const a = 1;", "+return fetchEverything(now)"]), "");
    expect(far[0].intra).toBeUndefined();
    expect(far[0].pairedWith).toBeUndefined();
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

describe("heartRowIndices", () => {
  it("marks the rows whose new-side number is in range, and the deletions they replace", () => {
    const rows = buildRows(
      { ...hunk(["-old a", "-old b", "+new 1", "+new 2", " ctx 3", "+new 4", "-old c", " ctx 5"]), newStart: 1 },
      "",
    );
    // new numbers: new 1 → 1, new 2 → 2, ctx 3 → 3, new 4 → 4, ctx 5 → 5
    const set = heartRowIndices(rows, [2, 3]);
    expect([...set].sort()).toEqual([3, 4]);
    const fromStart = heartRowIndices(rows, [1, 1]);
    expect([...fromStart].sort()).toEqual([0, 1, 2]);
    // a deletion right before a line outside the range stays unmarked
    expect([...heartRowIndices(rows, [4, 4])]).toEqual([5]);
  });
});

describe("unitProgress with skipped hunks", () => {
  const detail = {
    state: { hunks: { a: { viewed: true }, b: { viewed: false }, c: { viewed: false, changedSinceViewed: true } } },
  } as unknown as import("../api/types").PrDetail;
  const unit = (skip: string[] = []) =>
    ({
      hunks: ["a", "b", "c"].map((id) => (skip.includes(id) ? { id, skip: true, label: "adds imports" } : { id })),
    }) as unknown as import("../api/types").ReviewUnit;

  it("counts every hunk without a skip list", () => {
    expect(unitProgress(detail, unit())).toEqual({ viewed: 1, total: 3, changed: 1, skipped: 0 });
  });

  it("leaves skipped hunks out of viewed, total and changed", () => {
    expect(unitProgress(detail, unit(["c"]))).toEqual({
      viewed: 1,
      total: 2,
      changed: 0,
      skipped: 1,
    });
  });
});

describe("orderUnitHunks", () => {
  const file = (path: string, ids: string[]) =>
    ({ path, hunks: ids.map((id) => ({ id })) }) as unknown as import("../api/types").FileEntry;
  const files = [file("a.ts", ["a1", "a2"]), file("b.ts", ["b1"]), file("c.ts", ["c1", "c2"])];
  const ids = (out: { hunk: { id: string } }[]) => out.map((e) => e.hunk.id);

  it("is diff order without a heart, whatever order the ids came in", () => {
    expect(ids(orderUnitHunks(files, ["c2", "a2", "b1", "a1"], undefined))).toEqual(["a1", "a2", "b1", "c2"]);
  });

  it("puts the heart's files first, in heart order, keeping diff order inside a file", () => {
    const out = orderUnitHunks(files, ["a1", "a2", "b1", "c1", "c2"], [{ id: "c2" }, { id: "b1" }]);
    expect(ids(out)).toEqual(["c1", "c2", "b1", "a1", "a2"]);
  });

  it("takes the analysis's file order first, dropping paths the unit does not touch, then diff order", () => {
    const out = orderUnitHunks(files, ["a1", "a2", "b1", "c1"], [{ id: "a1" }], ["c.ts", "nope.ts", "b.ts"]);
    expect(ids(out)).toEqual(["c1", "b1", "a1", "a2"]);
  });

  it("falls back to the heart when the file order names nothing it holds", () => {
    expect(ids(orderUnitHunks(files, ["a1", "b1"], [{ id: "b1" }], ["nope.ts"]))).toEqual(["b1", "a1"]);
  });

  it("ignores a heart whose hunk is not in the unit", () => {
    expect(ids(orderUnitHunks(files, ["a1", "b1"], [{ id: "c1" }]))).toEqual(["a1", "b1"]);
  });
});

