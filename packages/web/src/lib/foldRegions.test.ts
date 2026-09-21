import { describe, expect, it } from "vitest";
import type { MoveCounterpart } from "./moveDetection";
import {
  computeFoldRuns,
  foldLabel,
  foldPlaceholder,
  foldRegionHunkId,
  foldStartsFor,
  isFoldRegionFolded,
  toggleOpenedFoldRegion,
  moveFoldRegions,
  pruneOpenedFoldRegions,
  splitMoveCandidates,
  unifiedMoveCandidates,
  type FoldSlot,
  type MoveCandidate,
} from "./foldRegions";

const candidate = (exempt = false): FoldSlot => ({ candidate: true, exempt });
const gap: FoldSlot = { candidate: false, exempt: false };

describe("computeFoldRuns", () => {
  it("finds one run spanning every candidate row", () => {
    const slots = [candidate(), candidate(), candidate(), candidate()];
    expect(computeFoldRuns(slots, 4)).toEqual([{ from: 0, to: 4, exempt: false }]);
  });

  it("splits into two runs when a non-candidate row breaks the middle", () => {
    const slots = [candidate(), candidate(), candidate(), candidate(), gap, candidate(), candidate(), candidate(), candidate()];
    expect(computeFoldRuns(slots, 4)).toEqual([
      { from: 0, to: 4, exempt: false },
      { from: 5, to: 9, exempt: false },
    ]);
  });

  it("drops a run shorter than the minimum length", () => {
    const slots = [candidate(), candidate(), candidate()];
    expect(computeFoldRuns(slots, 4)).toEqual([]);
  });

  it("keeps a run right at the minimum length", () => {
    const slots = [candidate(), candidate(), candidate(), candidate()];
    expect(computeFoldRuns(slots, 4)).toHaveLength(1);
  });

  it("marks a run exempt when any row inside is exempt, but still reports it", () => {
    const slots = [candidate(), candidate(true), candidate(), candidate()];
    expect(computeFoldRuns(slots, 4)).toEqual([{ from: 0, to: 4, exempt: true }]);
  });

  it("a trailing run with no closing gap still flushes", () => {
    const slots = [gap, candidate(), candidate(), candidate(), candidate()];
    expect(computeFoldRuns(slots, 4)).toEqual([{ from: 1, to: 5, exempt: false }]);
  });

  it("returns nothing for an empty input", () => {
    expect(computeFoldRuns([], 4)).toEqual([]);
  });
});

describe("unifiedMoveCandidates", () => {
  const moveIndex = {
    removedIdx: [0, undefined, 1, undefined, undefined],
    addedIdx: [undefined, 0, undefined, 1, 2],
  };

  it("flags removed rows that are in movedOut for kind 'out'", () => {
    const rows = ["del", "add", "del", "add", "add"] as const;
    const out = unifiedMoveCandidates(rows, moveIndex, { movedOut: new Set([0, 1]), movedIn: new Set() }, "out");
    expect(out.map((c) => c.candidate)).toEqual([true, false, true, false, false]);
    expect(out[0].contentIdx).toBe(0);
    expect(out[2].contentIdx).toBe(1);
  });

  it("flags added rows that are in movedIn for kind 'in'", () => {
    const rows = ["del", "add", "del", "add", "add"] as const;
    const inRows = unifiedMoveCandidates(rows, moveIndex, { movedOut: new Set(), movedIn: new Set([0, 2]) }, "in");
    expect(inRows.map((c) => c.candidate)).toEqual([false, true, false, false, true]);
  });

  it("context rows are never candidates for either kind", () => {
    const rows = ["context"] as const;
    const idx = { removedIdx: [0], addedIdx: [0] };
    const moves = { movedOut: new Set([0]), movedIn: new Set([0]) };
    expect(unifiedMoveCandidates(rows, idx, moves, "out")[0].candidate).toBe(false);
    expect(unifiedMoveCandidates(rows, idx, moves, "in")[0].candidate).toBe(false);
  });
});

describe("splitMoveCandidates", () => {
  const moveIndex = {
    removedIdx: [0, 1, undefined],
    addedIdx: [undefined, undefined, 0],
  };

  it("counts a pair whose other side is empty", () => {
    const pairs = [{ leftType: "del" as const, leftUnifiedIndex: 0 }];
    const out = splitMoveCandidates(pairs, moveIndex, { movedOut: new Set([0]), movedIn: new Set() }, "out");
    expect(out).toEqual([{ candidate: true, contentIdx: 0 }]);
  });

  it("counts a pair whose other side is itself moved", () => {
    const idx = { removedIdx: [0], addedIdx: [undefined, 1] };
    const pairs = [{ leftType: "del" as const, leftUnifiedIndex: 0, rightType: "add" as const, rightUnifiedIndex: 1 }];
    const out = splitMoveCandidates(pairs, idx, { movedOut: new Set([0]), movedIn: new Set([1]) }, "out");
    expect(out[0].candidate).toBe(true);
  });

  it("a real, non-moved line on the other side breaks the pairing", () => {
    const idx = { removedIdx: [0], addedIdx: [undefined, 1] };
    const pairs = [{ leftType: "del" as const, leftUnifiedIndex: 0, rightType: "add" as const, rightUnifiedIndex: 1 }];
    // right side is an add row, but NOT in movedIn — a genuinely new line.
    const out = splitMoveCandidates(pairs, idx, { movedOut: new Set([0]), movedIn: new Set() }, "out");
    expect(out[0].candidate).toBe(false);
  });

  it("symmetric check for kind 'in': a real line on the left breaks it", () => {
    const idx = { removedIdx: [0], addedIdx: [undefined, 1] };
    const pairs = [{ leftType: "del" as const, leftUnifiedIndex: 0, rightType: "add" as const, rightUnifiedIndex: 1 }];
    const out = splitMoveCandidates(pairs, idx, { movedOut: new Set(), movedIn: new Set([1]) }, "in");
    expect(out[0].candidate).toBe(false);
  });

  it("a filler (null) cell on the left never breaks an 'in' pairing", () => {
    const idx = { removedIdx: [], addedIdx: [0] };
    const pairs = [{ rightType: "add" as const, rightUnifiedIndex: 0 }];
    const out = splitMoveCandidates(pairs, idx, { movedOut: new Set(), movedIn: new Set([0]) }, "in");
    expect(out[0].candidate).toBe(true);
  });
});

describe("foldLabel", () => {
  const oneIn: MoveCounterpart[] = [
    { path: "internal/browser/manager.go", hunkId: "h1", direction: "in" },
  ];
  const oneOut: MoveCounterpart[] = [{ path: "sandbox_runtime.go", hunkId: "h2", direction: "out" }];
  const twoIn: MoveCounterpart[] = [
    { path: "a.go", hunkId: "h1", direction: "in" },
    { path: "b.go", hunkId: "h2", direction: "in" },
  ];

  it("names the single counterpart for a moved-in region", () => {
    expect(foldLabel("in", 39, oneIn)).toBe("39 lines moved from internal/browser/manager.go");
  });

  it("names the single counterpart for a moved-out region", () => {
    expect(foldLabel("out", 39, oneOut)).toBe("39 lines moved to sandbox_runtime.go");
  });

  it("summarizes several counterparts by count instead of listing them", () => {
    expect(foldLabel("in", 12, twoIn)).toBe("12 lines moved from 2 files");
  });

  it("singularizes 'line' for a one-line region", () => {
    expect(foldLabel("in", 1, oneIn)).toBe("1 line moved from internal/browser/manager.go");
  });

  it("dedupes two counterparts that share a path", () => {
    const dup: MoveCounterpart[] = [
      { path: "a.go", hunkId: "h1", direction: "in" },
      { path: "a.go", hunkId: "h2", direction: "in" },
    ];
    expect(foldLabel("in", 5, dup)).toBe("5 lines moved from a.go");
  });

  it("ignores counterparts of the other direction", () => {
    const mixed: MoveCounterpart[] = [...oneIn, ...oneOut];
    expect(foldLabel("in", 5, mixed)).toBe("5 lines moved from internal/browser/manager.go");
  });
});

describe("moveFoldRegions", () => {
  it("builds a keyed, labelled region from qualifying candidates", () => {
    const candidates: MoveCandidate[] = [
      { candidate: true, contentIdx: 5 },
      { candidate: true, contentIdx: 6 },
      { candidate: true, contentIdx: 7 },
      { candidate: true, contentIdx: 8 },
    ];
    const regions = moveFoldRegions({
      hunkId: "h1",
      kind: "in",
      candidates,
      exempt: [false, false, false, false],
      counterparts: [{ path: "src/a.go", hunkId: "h0", direction: "in" }],
    });
    expect(regions).toEqual([
      {
        key: "h1:in:5",
        kind: "in",
        from: 0,
        to: 4,
        hidden: 4,
        exempt: false,
        label: "4 lines moved from src/a.go",
        contentFrom: 5,
      },
    ]);
  });

  it("keeps the key stable regardless of where in row-space the run sits", () => {
    // Same content range (5..8), just offset later in row-space (e.g. the
    // split-mode rendering of the same underlying move) — the key must match
    // the unified-mode region above so manual-open state carries over.
    const candidates: MoveCandidate[] = [
      { candidate: false },
      { candidate: false },
      { candidate: true, contentIdx: 5 },
      { candidate: true, contentIdx: 6 },
      { candidate: true, contentIdx: 7 },
      { candidate: true, contentIdx: 8 },
    ];
    const [region] = moveFoldRegions({
      hunkId: "h1",
      kind: "in",
      candidates,
      exempt: candidates.map(() => false),
      counterparts: [],
    });
    expect(region.key).toBe("h1:in:5");
  });

  it("a region touched by an exempt row is reported but flagged exempt", () => {
    const candidates: MoveCandidate[] = [
      { candidate: true, contentIdx: 0 },
      { candidate: true, contentIdx: 1 },
      { candidate: true, contentIdx: 2 },
      { candidate: true, contentIdx: 3 },
    ];
    const [region] = moveFoldRegions({
      hunkId: "h1",
      kind: "out",
      candidates,
      exempt: [false, true, false, false],
      counterparts: [],
    });
    expect(region.exempt).toBe(true);
  });

  it("drops a run shorter than the minimum fold length", () => {
    const candidates: MoveCandidate[] = [
      { candidate: true, contentIdx: 0 },
      { candidate: true, contentIdx: 1 },
      { candidate: true, contentIdx: 2 },
    ];
    const regions = moveFoldRegions({
      hunkId: "h1",
      kind: "in",
      candidates,
      exempt: [false, false, false],
      counterparts: [],
    });
    expect(regions).toEqual([]);
  });
});

describe("pruneOpenedFoldRegions", () => {
  it("drops regions whose hunk left the pane", () => {
    const opened = new Set(["h1:in:0", "h2:out:3"]);
    expect(pruneOpenedFoldRegions(opened, ["h1"])).toEqual(new Set(["h1:in:0"]));
  });

  it("is a no-op — same reference — when nothing would change", () => {
    const opened = new Set(["h1:in:0"]);
    expect(pruneOpenedFoldRegions(opened, ["h1", "h2"])).toBe(opened);
  });
});

describe("folding and unfolding a region through its placeholder", () => {
  // Mirrors DiffPane: the rows memo renders a placeholder for every folded
  // region start, the placeholder's click toggles open state, and the next
  // rows pass reads that state back by region key.
  const [region] = moveFoldRegions({
    hunkId: "h1",
    kind: "in",
    candidates: [5, 6, 7, 8].map((contentIdx) => ({ candidate: true, contentIdx })),
    exempt: [false, false, false, false],
    counterparts: [],
  });

  it("expands when the placeholder is clicked (regression: row key vs region key)", () => {
    let opened: ReadonlySet<string> = new Set();
    expect(foldStartsFor([region], opened).folded.get(0)).toBe(region);

    const placeholder = foldPlaceholder(region);
    // The row key is the virtualizer's, and differs from the region key —
    // toggling by it is what left the region folded forever.
    expect(placeholder.key).not.toBe(region.key);
    opened = toggleOpenedFoldRegion(opened, placeholder.regionKey);

    expect(isFoldRegionFolded(region, opened)).toBe(false);
    expect(foldStartsFor([region], opened).folded.size).toBe(0);
    expect(foldStartsFor([region], opened).opened.get(0)).toBe(region);
    // and it survives the pane's prune pass while its hunk is still shown
    expect(pruneOpenedFoldRegions(opened, ["h1"])).toBe(opened);
  });

  it("folds back up when the opened region's fold control is clicked", () => {
    let opened: ReadonlySet<string> = toggleOpenedFoldRegion(new Set(), foldPlaceholder(region).regionKey);
    const [first] = foldStartsFor([region], opened).opened.values();
    opened = toggleOpenedFoldRegion(opened, first.key);
    expect(isFoldRegionFolded(region, opened)).toBe(true);
    expect(foldStartsFor([region], opened).folded.get(0)).toBe(region);
    expect(foldStartsFor([region], opened).opened.size).toBe(0);
  });

  it("offers neither a placeholder nor a fold control for an exempt region", () => {
    const exempt = { ...region, exempt: true };
    const starts = foldStartsFor([exempt], new Set([exempt.key]));
    expect(starts.folded.size).toBe(0);
    expect(starts.opened.size).toBe(0);
  });
});

describe("foldRegionHunkId", () => {
  it("parses the hunk id from the right, so ids containing a colon survive", () => {
    expect(foldRegionHunkId("h1:in:5")).toBe("h1");
    expect(foldRegionHunkId("a:b:out:12")).toBe("a:b");
    expect(pruneOpenedFoldRegions(new Set(["a:b:out:12"]), ["a:b"])).toEqual(new Set(["a:b:out:12"]));
  });
});
