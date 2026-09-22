import { describe, expect, it } from "vitest";
import type { Hunk, HunkLineChange, RevisionLineChanges } from "../api/types";
import { buildRows, buildSplitRows, hunkBodyLines } from "./diffModel";
import {
  buildHighlight,
  highlightSummaryText,
  highlightTally,
  hunkChangedLabel,
  markedByHunk,
  markedRowIndexes,
  rawHunkLines,
  removalLabel,
  removalMarks,
  removalMarksByHunk,
  revisionsLabel,
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
    expect(
      splitRemovalMarks(new Map([[4, { above: 2, aboveIn: [3] }], [3, { above: 1, aboveIn: [5] }]]), split),
    ).toEqual(
      new Map([
        [3, { above: 2, aboveIn: [3] }],
        [2, { above: 1, aboveIn: [5] }],
      ]),
    );
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
    expect(removalMarksByHunk([h], buildHighlight(data), "").get("rm1")).toEqual(
      new Map([[1, { above: 2, aboveIn: [3] }]]),
    );
    expect(removalLabel([3], 2)).toBe("2 lines removed in r3");
    expect(removalLabel([3], 1)).toBe("1 line removed in r3");
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
    expect(hunkChangedLabel(h.byHunk.get("a")!)).toEqual({
      text: "changed in r5 · 3 lines removed · 2 since rewritten",
      title:
        "Changed again after r5. The marks are exact: they follow r5's own lines. 2 of r5's lines were rewritten by later revisions.",
    });
    expect(hunkChangedLabel(h.byHunk.get("b")!)).toEqual({
      text: "changed in r5",
      title: "Lines this hunk gained in r5",
    });
    const c = hunkChangedLabel(h.byHunk.get("c")!);
    expect(c.text).toBe("changed in r5");
    expect(c.title).toContain("None of r5's lines were rewritten");
  });
});

describe("several revisions at once", () => {
  const change = (over: Partial<HunkLineChange> & { currentHunkId: string }): HunkLineChange => ({
    originHunkId: over.currentHunkId,
    file: "a.ts",
    status: "fuzzy",
    lines: [],
    removedCount: 0,
    removedAt: [],
    rewrittenSince: 0,
    exactAtCurrent: false,
    ...over,
  });
  const rev = (revision: number, hunks: HunkLineChange[], gone: RevisionLineChanges["gone"] = []) => ({
    revision,
    currentRevision: 7,
    hunks,
    goneCount: gone.length,
    gone,
  });
  // r3 added rows 1-3 of `a`; r5 rewrote one of them (now row 3) and added row 6.
  // r4, not highlighted, rewrote another of r3's lines.
  const r3 = rev(
    3,
    [
      change({
        currentHunkId: "a",
        originHunkId: "a3",
        lines: [1, 2],
        removedCount: 2,
        removedAt: [{ line: 5, count: 2 }],
        rewrittenSince: 2,
        rewrittenBy: [
          { revision: 4, count: 1 },
          { revision: 5, count: 1 },
        ],
      }),
      change({ currentHunkId: "b", originHunkId: "b3", lines: [0] }),
    ],
    [{ originHunkId: "g3", lastHunkId: "g", file: "g.ts", goneAtRevision: 6, unitId: "u1" }],
  );
  const r5 = rev(
    5,
    [
      change({
        currentHunkId: "a",
        originHunkId: "a5",
        lines: [2, 3, 6],
        removedCount: 1,
        removedAt: [
          { line: 5, count: 1 },
          { line: 7, count: 1 },
        ],
        exactAtCurrent: true,
      }),
    ],
    [{ originHunkId: "g5", lastHunkId: "g", file: "g.ts", goneAtRevision: 6, unitId: "u1" }],
  );

  it("unions the marked lines and lists the revisions per hunk", () => {
    const h = buildHighlight([r5, r3]);
    expect(h.revisions).toEqual([3, 5]);
    const a = h.byHunk.get("a")!;
    expect(a.revisions).toEqual([3, 5]);
    expect([...a.lines].sort()).toEqual([1, 2, 3, 6]);
    expect(a.lineCount).toBe(4);
    expect(h.byHunk.get("b")!.revisions).toEqual([3]);
    expect(highlightTally(h)).toEqual({ lines: 5, hunks: 2 });
  });

  it("adds up deletions from different revisions at one anchor, and keeps who made them", () => {
    const a = buildHighlight([r3, r5]).byHunk.get("a")!;
    expect(a.removedCount).toBe(3);
    expect(a.removedAt).toEqual([
      { line: 5, count: 3, revisions: [3, 5] },
      { line: 7, count: 1, revisions: [5] },
    ]);
    expect(removalMarks(8, a.removedAt)).toEqual(
      new Map([
        [5, { above: 3, aboveIn: [3, 5] }],
        [7, { above: 1, aboveIn: [5] }],
      ]),
    );
    expect(removalLabel([3, 5], 3)).toBe("3 lines removed in r3, r5");
  });

  it("counts the same deletion once when one origin reaches a hunk twice", () => {
    const twice = rev(3, [
      change({ currentHunkId: "m", originHunkId: "o", lines: [1], removedCount: 2, removedAt: [{ line: 4, count: 2 }] }),
      change({ currentHunkId: "m", originHunkId: "o", lines: [2], removedCount: 2, removedAt: [{ line: 4, count: 2 }] }),
    ]);
    const m = buildHighlight(twice).byHunk.get("m")!;
    expect([...m.lines]).toEqual([1, 2]);
    expect(m.removedCount).toBe(2);
    expect(m.removedAt).toEqual([{ line: 4, count: 2, revisions: [3] }]);
  });

  it("two origins of one revision merged into one hunk both count (no overwrite)", () => {
    const merged = rev(3, [
      change({ currentHunkId: "m", originHunkId: "o1", lines: [1], removedCount: 1, removedAt: [{ line: 4, count: 1 }] }),
      change({ currentHunkId: "m", originHunkId: "o2", lines: [6], removedCount: 2, removedAt: [{ line: 4, count: 2 }] }),
    ]);
    const m = buildHighlight(merged).byHunk.get("m")!;
    expect([...m.lines]).toEqual([1, 6]);
    expect(m.removedCount).toBe(3);
    expect(m.removedAt).toEqual([{ line: 4, count: 3, revisions: [3] }]);
  });

  it("leaves out of 'since rewritten' what another highlighted revision rewrote", () => {
    expect(buildHighlight(r3).byHunk.get("a")!.rewrittenSince).toBe(2);
    expect(buildHighlight([r3, r5]).byHunk.get("a")!.rewrittenSince).toBe(1);
    // an older server: no breakdown, the plain count stands
    const old = rev(3, [change({ currentHunkId: "a", lines: [1], rewrittenSince: 2 })]);
    expect(buildHighlight([old, r5]).byHunk.get("a")!.rewrittenSince).toBe(2);
  });

  it("takes exactness from the latest revision, uncertainty from any", () => {
    const h = buildHighlight([r3, r5]);
    expect(h.byHunk.get("a")!.exactAtCurrent).toBe(true);
    expect(h.byHunk.get("a")!.uncertain).toBe(false);
    const shaky = rev(5, [change({ currentHunkId: "a", lines: [6], uncertain: true })]);
    const u = buildHighlight([r3, shaky]).byHunk.get("a")!;
    expect(u.exactAtCurrent).toBe(false);
    expect(u.uncertain).toBe(true);
  });

  it("counts a gone hunk once however many revisions lead to it", () => {
    expect(buildHighlight([r3, r5], { hunkIds: ["a"], unitId: "u1" }).goneCount).toBe(1);
    expect(buildHighlight([r3, r5], { hunkIds: ["a"], unitId: "u2" }).goneCount).toBe(0);
    expect(buildHighlight([r3, r5]).goneCount).toBe(1);
  });

  it("labels the hunk chip with every revision, the tooltip in words", () => {
    const h = buildHighlight([r3, r5]);
    expect(hunkChangedLabel(h.byHunk.get("a")!)).toEqual({
      text: "changed in r3, r5 · 3 lines removed · 1 since rewritten",
      title: "Lines this hunk gained in r3 and r5. 1 of their lines was rewritten by revisions outside the highlight.",
    });
    const r6 = rev(6, [change({ currentHunkId: "a", originHunkId: "a6", lines: [0] })]);
    const later = hunkChangedLabel(buildHighlight([r3, r5, r6]).byHunk.get("a")!);
    expect(later.text).toBe("changed in r3, r5, r6 · 3 lines removed · 1 since rewritten");
    expect(later.title).toBe(
      "Changed again after r6. The marks are exact: they follow each revision's own lines. 1 of their lines was rewritten by revisions outside the highlight.",
    );
    // one revision in the set keeps the single-revision wording
    expect(hunkChangedLabel(h.byHunk.get("b")!).text).toBe("changed in r3");
  });

  it("joins revisions for the summary and header chip", () => {
    expect(revisionsLabel([3])).toBe("r3");
    expect(revisionsLabel([3, 5], " + ")).toBe("r3 + r5");
  });

  it("summarises: loading until all are in, the failing revision by name, then the tally", () => {
    expect(highlightSummaryText([3, 5], null, null)).toBe("Loading the changes from r3 + r5…");
    expect(highlightSummaryText([3, 5], null, { revision: 5, error: new Error("boom") })).toBe(
      "Couldn't load the changes from r5: boom",
    );
    const h = buildHighlight([r3, r5], { hunkIds: ["a", "b"], unitId: "u1" });
    expect(highlightSummaryText([3, 5], h, null)).toBe(
      "Showing changes from r3 + r5 · 5 lines in 2 hunks · 1 hunk since removed",
    );
    expect(highlightSummaryText([3], buildHighlight(r3, { hunkIds: ["zz"] }), null)).toBe(
      "Showing changes from r3 · none in this unit's current hunks",
    );
  });
});
