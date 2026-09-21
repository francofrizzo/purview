import { describe, expect, it } from "vitest";
import type { Hunk, RevisionLineChanges } from "../api/types";
import { buildRows, buildSplitRows, hunkBodyLines } from "./diffModel";
import {
  buildHighlight,
  highlightTally,
  hunkChangedLabel,
  markedByHunk,
  markedRowIndexes,
  rawHunkLines,
  removalLabel,
  removalMarks,
  removalMarksByHunk,
  splitRemovalMarks,
} from "./revisionHighlight";

/** A hunk as the API client hands it over: `lines` from core's `text`. */
function wireHunk(id: string, text: string): Hunk {
  const lines = hunkBodyLines(text);
  return {
    id,
    file: "a.go",
    oldStart: 10,
    oldLines: lines?.filter((l) => !l.startsWith("+")).length ?? 0,
    newStart: 10,
    newLines: lines?.filter((l) => !l.startsWith("-")).length ?? 0,
    header: "",
    addedLines: [],
    removedLines: [],
    text,
    lines,
  } as unknown as Hunk;
}

describe("the index space shared with core", () => {
  // Real-shaped Go hunk: repeated `}` lines, a blank added line, and a
  // "\ No newline" marker mid-body. Core's `hunkBodyLines(text)[i]` is body line i.
  const text = [
    " func f() error {",
    "-\treturn nil",
    "\\ No newline at end of file",
    "+\tif err != nil {",
    "+\t\treturn err",
    "+\t}",
    "+",
    "+\tif ok {",
    "+\t\treturn err",
    "+\t}",
    " }",
  ].join("\n");
  const hunk = wireHunk("idx1", text);

  it("hunk.lines, rawHunkLines and buildRows all index `text.split('\\n')`, markers and blanks kept", () => {
    expect(hunk.lines).toEqual(text.split("\n"));
    expect(rawHunkLines(hunk, "")).toEqual(text.split("\n"));
    const rows = buildRows(hunk, "");
    expect(rows).toHaveLength(text.split("\n").length);
    text.split("\n").forEach((raw, i) => expect(rows[i].content).toBe(raw.slice(1)));
  });

  it("an empty body stays empty", () => {
    expect(hunkBodyLines("")).toBeUndefined();
  });

  it("a position marks that row only, not its repeats", () => {
    // core would send [7, 8, 9] for "r5 added the second if-block"
    const data: RevisionLineChanges = {
      revision: 5,
      currentRevision: 5,
      hunks: [
        { currentHunkId: "idx1", originHunkId: "idx1", file: "a.go", status: "fuzzy", lines: [7, 8, 9], removedCount: 0, removedAt: [], rewrittenSince: 0, exactAtCurrent: true },
      ],
      goneCount: 0,
      gone: [],
    };
    const marked = markedByHunk([hunk], buildHighlight(data), "").get("idx1")!;
    expect([...marked]).toEqual([7, 8, 9]);
    const rows = buildRows(hunk, "");
    expect([...marked].map((i) => rows[i].content)).toEqual(["\tif ok {", "\t\treturn err", "\t}"]);
    // the earlier `return err` / `}` rows (4, 5) stay unmarked
    expect(marked.has(4) || marked.has(5)).toBe(false);
  });
});

describe("markedRowIndexes", () => {
  it("keeps positions inside the rendered rows, drops the rest", () => {
    expect([...markedRowIndexes(5, [0, 3, 4, 5, -1, 9])]).toEqual([0, 3, 4]);
    expect(markedRowIndexes(5, []).size).toBe(0);
  });
});

describe("removalMarks", () => {
  it("puts a deletion on the row after it, or below the last row at the end", () => {
    expect(removalMarks(4, [{ line: 2, count: 3 }, { line: 4, count: 1 }])).toEqual(
      new Map([
        [2, { above: 3 }],
        [3, { below: 1 }],
      ]),
    );
    expect(removalMarks(4, [{ line: 7, count: 1 }]).size).toBe(0);
    expect(removalMarks(0, [{ line: 0, count: 1 }]).size).toBe(0);
  });

  it("maps onto split rows (left half), including anchors inside a del/add run", () => {
    const h = wireHunk("split1", [" a", "-b", "+B", "+C", " d"].join("\n"));
    const split = buildSplitRows(h, "");
    // split rows: [a|a], [-b|+B], [ |+C], [d|d]
    expect(splitRemovalMarks(new Map([[4, { above: 2 }], [3, { above: 1 }]]), split)).toEqual(
      new Map([
        [3, { above: 2 }],
        [2, { above: 1 }],
      ]),
    );
    expect(splitRemovalMarks(new Map([[4, { below: 1 }]]), split)).toEqual(new Map([[3, { below: 1 }]]));
  });

  it("is computed per hunk from the highlight", () => {
    const h = wireHunk("rm1", [" a", " b", " c"].join("\n"));
    const data: RevisionLineChanges = {
      revision: 3,
      currentRevision: 3,
      hunks: [
        { currentHunkId: "rm1", originHunkId: "rm1", file: "a.go", status: "fuzzy", lines: [], removedCount: 2, removedAt: [{ line: 1, count: 2 }], rewrittenSince: 0, exactAtCurrent: true },
      ],
      goneCount: 0,
      gone: [],
    };
    expect(removalMarksByHunk([h], buildHighlight(data), "").get("rm1")).toEqual(new Map([[1, { above: 2 }]]));
    expect(removalLabel(3, 2)).toBe("2 lines removed in r3");
    expect(removalLabel(3, 1)).toBe("1 line removed in r3");
  });
});

describe("buildHighlight", () => {
  const data: RevisionLineChanges = {
    revision: 5,
    currentRevision: 7,
    hunks: [
      { currentHunkId: "a", originHunkId: "a0", file: "a.ts", status: "fuzzy", lines: [2, 4], removedCount: 3, removedAt: [{ line: 1, count: 3 }], rewrittenSince: 2, exactAtCurrent: false },
      { currentHunkId: "b", originHunkId: "b", file: "b.ts", status: "new", lines: [0], removedCount: 0, removedAt: [], rewrittenSince: 0, exactAtCurrent: true },
      { currentHunkId: "c", originHunkId: "c0", file: "c.ts", status: "fuzzy", lines: [1], removedCount: 0, removedAt: [], rewrittenSince: 0, exactAtCurrent: false },
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
    expect([...h.byHunk.get("a")!.lines]).toEqual([2, 4]);
    expect(h.goneCount).toBe(1);
    expect(highlightTally(h)).toEqual({ lines: 2, hunks: 1 });
  });

  it("labels the hunk header: removals, later rewrites, and the exact-marks tooltip", () => {
    const h = buildHighlight(data);
    expect(hunkChangedLabel(5, h.byHunk.get("a")!)).toEqual({
      text: "changed in r5 · 3 lines removed · 2 since rewritten",
      title:
        "Changed again after r5. The marks are exact: they follow r5's own lines. 2 of r5's lines were rewritten by later revisions.",
    });
    expect(hunkChangedLabel(5, h.byHunk.get("b")!)).toEqual({
      text: "changed in r5",
      title: "Lines this hunk gained in r5",
    });
    const c = hunkChangedLabel(5, h.byHunk.get("c")!);
    expect(c.text).toBe("changed in r5");
    expect(c.title).toContain("None of r5's lines were rewritten");
  });
});
