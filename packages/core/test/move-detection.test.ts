import { describe, expect, it } from "vitest";
import { detectMoves, summarizeMoves, type MoveFile } from "../src/move-detection.js";

/**
 * Behavioral-contract vectors shared with the web mirror
 * (packages/web/src/lib/moveDetection.test.ts) — the two implementations
 * must agree on these. See the MIRRORED IMPLEMENTATION note in either file.
 */

const BLOCK = [
  "func computeTotal(items []Item) int {",
  "  total := 0",
  "  for _, it := range items {",
  "    total += it.Price",
  "  }",
  "  return total",
  "}",
];

const file = (path: string, hunks: MoveFile["hunks"]): MoveFile => ({ path, hunks });
const hunk = (id: string, removed: string[], added: string[]) => ({
  id,
  removedLines: removed,
  addedLines: added,
});

describe("detectMoves (core mirror)", () => {
  it("pairs a cross-file extraction buried in mixed hunks", () => {
    const files = [
      file("a.go", [hunk("h1", [...BLOCK, "var unrelatedRemoved = 1"], ["var unrelatedAdded = 2"])]),
      file("b.go", [hunk("h2", [], ["package b", "", ...BLOCK, "func newStuff() {}"])]),
    ];
    const moves = detectMoves(files);
    const out = moves.get("h1")!;
    const into = moves.get("h2")!;
    expect(out.movedOut.size).toBe(BLOCK.length);
    // the unrelated removed line stays untagged
    expect(out.movedOut.has(BLOCK.length)).toBe(false);
    expect(into.movedIn.size).toBe(BLOCK.length);
    expect(out.counterparts).toEqual([{ path: "b.go", hunkId: "h2", direction: "out" }]);
    expect(into.counterparts).toEqual([{ path: "a.go", hunkId: "h1", direction: "in" }]);
  });

  it("survives reindentation of the moved block", () => {
    const reindented = BLOCK.map((l) => "    " + l);
    const files = [
      file("a.go", [hunk("h1", BLOCK, [])]),
      file("b.go", [hunk("h2", [], reindented)]),
    ];
    expect(detectMoves(files).get("h1")!.movedOut.size).toBe(BLOCK.length);
  });

  it("never pairs runs of insignificant lines", () => {
    const braces = ["}", "})", "end", "}"];
    const files = [
      file("a.go", [hunk("h1", braces, [])]),
      file("b.go", [hunk("h2", [], braces)]),
    ];
    expect(detectMoves(files).size).toBe(0);
  });

  it("requires three significant lines", () => {
    const two = ["longEnoughLineNumberOne()", "longEnoughLineNumberTwo()"];
    const files = [file("a.go", [hunk("h1", two, [])]), file("b.go", [hunk("h2", [], two)])];
    expect(detectMoves(files).size).toBe(0);
  });

  it("summarizes pairs sorted by volume", () => {
    const files = [
      file("a.go", [hunk("h1", BLOCK, [])]),
      file("b.go", [hunk("h2", [], BLOCK)]),
    ];
    const summary = summarizeMoves(files);
    expect(summary).toHaveLength(1);
    expect(summary[0].fromPath).toBe("a.go");
    expect(summary[0].toPath).toBe("b.go");
    expect(summary[0].lines).toBe(BLOCK.length);
  });

  it("summarizes nothing when nothing moved", () => {
    expect(summarizeMoves([file("a.go", [hunk("h1", ["x := 1"], ["y := 2"])])])).toEqual([]);
  });
});
