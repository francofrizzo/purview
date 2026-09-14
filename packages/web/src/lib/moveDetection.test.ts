import { describe, expect, it } from "vitest";
import type { FileEntry, Hunk } from "../api/types";
import { detectMoves } from "./moveDetection";

let n = 0;
function mkHunk(file: string, added: string[], removed: string[]): Hunk {
  n += 1;
  return {
    id: `h${n}`,
    file,
    oldStart: 1,
    oldLines: removed.length,
    newStart: 1,
    newLines: added.length,
    header: "",
    addedLines: added,
    removedLines: removed,
  };
}

function mkFile(path: string, hunks: Hunk[]): FileEntry {
  return { path, hunks };
}

// Each line here is >= 8 trimmed chars (and has a real word), so every line
// is "significant" on its own — a run built from these needs only 3 of them
// to qualify.
const BLOCK = [
  "function helper() {",
  "  return doWork(argOne, argTwo);",
  "}",
  "  console.log(argOne);",
  "  console.log(argTwo);",
];

describe("detectMoves", () => {
  it("pairs an exact move across two files", () => {
    const from = mkHunk("src/old.ts", [], BLOCK);
    const to = mkHunk("src/new.ts", BLOCK, []);
    const files = [mkFile("src/old.ts", [from]), mkFile("src/new.ts", [to])];

    const moves = detectMoves(files);

    const fromMoves = moves.get(from.id)!;
    const toMoves = moves.get(to.id)!;
    expect([...fromMoves.movedOut]).toEqual([0, 1, 2, 3, 4]);
    expect(fromMoves.counterparts).toEqual([{ path: "src/new.ts", hunkId: to.id, direction: "out" }]);
    expect([...toMoves.movedIn]).toEqual([0, 1, 2, 3, 4]);
    expect(toMoves.counterparts).toEqual([{ path: "src/old.ts", hunkId: from.id, direction: "in" }]);
  });

  it("pairs a move within one file between two hunks", () => {
    const from = mkHunk("src/a.ts", [], BLOCK);
    const to = mkHunk("src/a.ts", BLOCK, []);
    const files = [mkFile("src/a.ts", [from, to])];

    const moves = detectMoves(files);

    expect(moves.get(from.id)?.counterparts[0]).toMatchObject({ path: "src/a.ts", direction: "out" });
    expect(moves.get(to.id)?.counterparts[0]).toMatchObject({ path: "src/a.ts", direction: "in" });
  });

  it("still matches when the moved block was reindented (whitespace-only)", () => {
    const reindented = BLOCK.map((l) => `    ${l}`);
    const from = mkHunk("src/old.ts", [], BLOCK);
    const to = mkHunk("src/new.ts", reindented, []);
    const files = [mkFile("src/old.ts", [from]), mkFile("src/new.ts", [to])];

    const moves = detectMoves(files);

    expect(moves.get(from.id)?.counterparts[0]?.hunkId).toBe(to.id);
    expect(moves.get(to.id)?.counterparts[0]?.hunkId).toBe(from.id);
  });

  it("does not pair when the two sides share fewer than 3 significant lines", () => {
    const from = mkHunk("src/old.ts", [], BLOCK);
    const to = mkHunk(
      "src/new.ts",
      ["function helper() {", "totally unrelated content down here", "}"],
      [],
    );
    const files = [mkFile("src/old.ts", [from]), mkFile("src/new.ts", [to])];

    const moves = detectMoves(files);

    expect(moves.size).toBe(0);
  });

  it("never pairs a trivial-line-only run (braces, no real content)", () => {
    const from = mkHunk("src/old.ts", [], ["}", "}", "}"]);
    const to = mkHunk("src/new.ts", ["}", "}", "}"], []);
    const files = [mkFile("src/old.ts", [from]), mkFile("src/new.ts", [to])];

    const moves = detectMoves(files);

    expect(moves.size).toBe(0);
  });

  it("greedily consumes 1:1, keeping the longer of two competing runs", () => {
    // `from`'s removed block matches both `weak` (3 identical lines only)
    // and `strong` (the full 5-line block). Both qualify (>= 3 significant
    // lines), so the algorithm must prefer the longer, `strong`, and leave
    // `weak` unpaired even though it also cleared the bar.
    const from = mkHunk("src/a.ts", [], BLOCK);
    const strong = mkHunk("src/b.ts", BLOCK, []);
    const weak = mkHunk("src/c.ts", BLOCK.slice(0, 3), []);
    const files = [
      mkFile("src/a.ts", [from]),
      mkFile("src/b.ts", [strong]),
      mkFile("src/c.ts", [weak]),
    ];

    const moves = detectMoves(files);

    expect(moves.get(from.id)?.counterparts[0]?.hunkId).toBe(strong.id);
    expect(moves.get(strong.id)?.counterparts[0]?.hunkId).toBe(from.id);
    expect(moves.has(weak.id)).toBe(false);
  });

  it("returns an empty map for empty input", () => {
    expect(detectMoves([]).size).toBe(0);
  });

  it("finds a run buried inside a mixed hunk with unrelated changes around it", () => {
    // A single hunk removes a 5-line function (the extraction) plus two
    // unrelated novel lines; another hunk adds that same 5-line function
    // (now living elsewhere) plus its own unrelated novel line. Whole-hunk
    // Jaccard would score this well under 0.9 and miss it entirely; the
    // line-run detector should still find exactly the extracted lines.
    const mixedRemoved = [
      "// unrelated removed line one",
      ...BLOCK,
      "// unrelated removed line two",
    ];
    const mixedAdded = ["// unrelated added line", ...BLOCK];
    const from = mkHunk("src/manager.go", [], mixedRemoved);
    const to = mkHunk("src/sandbox_runtime.go", mixedAdded, []);
    const files = [mkFile("src/manager.go", [from]), mkFile("src/sandbox_runtime.go", [to])];

    const moves = detectMoves(files);

    const fromMoves = moves.get(from.id)!;
    const toMoves = moves.get(to.id)!;
    // Indexes 1..5 of mixedRemoved are BLOCK; the unrelated lines (0 and 6)
    // must not be flagged.
    expect([...fromMoves.movedOut].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    // Indexes 1..5 of mixedAdded are BLOCK; index 0 (unrelated) must not be.
    expect([...toMoves.movedIn].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("splits into two runs when a genuinely edited line breaks the match", () => {
    // Six significant lines, split by one edited line in the middle: the
    // first 3 and the last 3 should each independently qualify as their own
    // run (each meets the 3-significant-line bar on its own).
    const firstHalf = ["alpha line number one", "alpha line number two", "alpha line number three"];
    const secondHalf = ["beta line number one", "beta line number two", "beta line number three"];
    const removed = [...firstHalf, "this line only exists on the removed side", ...secondHalf];
    const added = [...firstHalf, "this line only exists on the added side", ...secondHalf];
    const from = mkHunk("src/old.ts", [], removed);
    const to = mkHunk("src/new.ts", added, []);
    const files = [mkFile("src/old.ts", [from]), mkFile("src/new.ts", [to])];

    const moves = detectMoves(files);

    const fromMoves = moves.get(from.id)!;
    const toMoves = moves.get(to.id)!;
    // Index 3 (the edited line) on both sides must not be flagged; 0-2 and
    // 4-6 must be.
    expect([...fromMoves.movedOut].sort((a, b) => a - b)).toEqual([0, 1, 2, 4, 5, 6]);
    expect([...toMoves.movedIn].sort((a, b) => a - b)).toEqual([0, 1, 2, 4, 5, 6]);
  });

  it("dedupes counterparts and orders them by first occurrence", () => {
    // Two separate runs between the same pair of hunks (broken by an edited
    // line in between) should collapse into one counterpart entry each way.
    const firstHalf = ["gamma line number one", "gamma line number two", "gamma line number three"];
    const secondHalf = ["delta line number one", "delta line number two", "delta line number three"];
    const removed = [...firstHalf, "edited only on the removed side", ...secondHalf];
    const added = [...firstHalf, "edited only on the added side", ...secondHalf];
    const from = mkHunk("src/old.ts", [], removed);
    const to = mkHunk("src/new.ts", added, []);
    const files = [mkFile("src/old.ts", [from]), mkFile("src/new.ts", [to])];

    const moves = detectMoves(files);

    expect(moves.get(from.id)?.counterparts).toEqual([
      { path: "src/new.ts", hunkId: to.id, direction: "out" },
    ]);
    expect(moves.get(to.id)?.counterparts).toEqual([
      { path: "src/old.ts", hunkId: from.id, direction: "in" },
    ]);
  });
});
