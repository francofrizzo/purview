import { describe, expect, it } from "vitest";
import type { MoveRun } from "./moveDetection";
import {
  computeFoldRuns,
  foldBandsAt,
  foldLabel,
  foldPlaceholder,
  foldRegionHunkId,
  isFoldRegionFolded,
  moveFoldRegions,
  moveTargets,
  pruneOpenedFoldRegions,
  setFoldRegionFolded,
  splitMoveCandidates,
  targetLabel,
  toggleFoldRegionKey,
  unifiedMoveCandidates,
  type FoldSlot,
  type LocateMoved,
  type MoveCandidate,
  type MoveTarget,
} from "./foldRegions";

const candidate = (exempt = false): FoldSlot => ({ candidate: true, exempt });
const gap: FoldSlot = { candidate: false, exempt: false };
/** a blank or `}` row between two halves of a run */
const filler = (exempt = false): FoldSlot => ({ candidate: false, exempt, bridge: true });

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

  describe("bridging", () => {
    it("steps over one blank row between two halves: one run, the blank folded with it", () => {
      const slots = [candidate(), candidate(), candidate(), filler(), candidate(), candidate(), candidate()];
      expect(computeFoldRuns(slots, 4)).toEqual([{ from: 0, to: 7, exempt: false }]);
    });

    it("steps over a `)` and a blank line (two rows), the most it will bridge", () => {
      const slots = [candidate(), candidate(), candidate(), filler(), filler(), candidate(), candidate(), candidate()];
      expect(computeFoldRuns(slots, 4)).toEqual([{ from: 0, to: 8, exempt: false }]);
    });

    it("a gap of three filler rows is not bridged: two runs, the gap stays out", () => {
      const slots = [
        candidate(), candidate(), candidate(), candidate(),
        filler(), filler(), filler(),
        candidate(), candidate(), candidate(), candidate(),
      ];
      expect(computeFoldRuns(slots, 4)).toEqual([
        { from: 0, to: 4, exempt: false },
        { from: 7, to: 11, exempt: false },
      ]);
    });

    it("a real changed line in the gap still breaks the run, however short the gap", () => {
      const slots = [candidate(), candidate(), candidate(), candidate(), gap, candidate(), candidate(), candidate(), candidate()];
      expect(computeFoldRuns(slots, 4)).toEqual([
        { from: 0, to: 4, exempt: false },
        { from: 5, to: 9, exempt: false },
      ]);
    });

    it("a blank next to a real line is no bridge either", () => {
      const slots = [candidate(), candidate(), candidate(), candidate(), filler(), gap, candidate(), candidate(), candidate(), candidate()];
      expect(computeFoldRuns(slots, 4)).toEqual([
        { from: 0, to: 4, exempt: false },
        { from: 6, to: 10, exempt: false },
      ]);
    });

    it("never starts or ends on filler: leading and trailing blanks stay out of the run", () => {
      const slots = [filler(), candidate(), candidate(), candidate(), candidate(), filler()];
      expect(computeFoldRuns(slots, 4)).toEqual([{ from: 1, to: 5, exempt: false }]);
    });

    it("a comment on a bridged row keeps the whole run open", () => {
      const slots = [candidate(), candidate(), candidate(), filler(true), candidate(), candidate(), candidate()];
      expect(computeFoldRuns(slots, 4)).toEqual([{ from: 0, to: 7, exempt: true }]);
    });

    it("a comment on filler that is not bridged exempts nothing", () => {
      const slots = [candidate(), candidate(), candidate(), candidate(), filler(true)];
      expect(computeFoldRuns(slots, 4)).toEqual([{ from: 0, to: 4, exempt: false }]);
    });

    it("counts bridged rows toward the minimum length", () => {
      // three moved lines, a brace, three more: seven rows, one band
      const slots = [candidate(), candidate(), candidate(), filler(), candidate(), candidate(), candidate()];
      expect(computeFoldRuns(slots, 7)).toHaveLength(1);
      expect(computeFoldRuns(slots, 8)).toHaveLength(0);
    });
  });
});

describe("unifiedMoveCandidates", () => {
  const moveIndex = {
    removedIdx: [0, undefined, 1, undefined, undefined],
    addedIdx: [undefined, 0, undefined, 1, 2],
  };

  const real = (type: string) => ({ type, content: "const total = order.total;" });
  const rows = [real("del"), real("add"), real("del"), real("add"), real("add")];

  it("flags removed rows that are in movedOut for kind 'out'", () => {
    const out = unifiedMoveCandidates(rows, moveIndex, { movedOut: new Set([0, 1]), movedIn: new Set() }, "out");
    expect(out.map((c) => c.candidate)).toEqual([true, false, true, false, false]);
    expect(out[0].contentIdx).toBe(0);
    expect(out[2].contentIdx).toBe(1);
  });

  it("flags added rows that are in movedIn for kind 'in'", () => {
    const inRows = unifiedMoveCandidates(rows, moveIndex, { movedOut: new Set(), movedIn: new Set([0, 2]) }, "in");
    expect(inRows.map((c) => c.candidate)).toEqual([false, true, false, false, true]);
  });

  it("context rows are never candidates for either kind", () => {
    const ctx = [real("context")];
    const idx = { removedIdx: [0], addedIdx: [0] };
    const moves = { movedOut: new Set([0]), movedIn: new Set([0]) };
    expect(unifiedMoveCandidates(ctx, idx, moves, "out")[0].candidate).toBe(false);
    expect(unifiedMoveCandidates(ctx, idx, moves, "in")[0].candidate).toBe(false);
  });

  it("a blank or punctuation-only non-candidate row is bridgeable, a real one is not", () => {
    const idx = { removedIdx: [undefined, undefined, undefined, undefined], addedIdx: [undefined, undefined, undefined, undefined] };
    const moves = { movedOut: new Set<number>(), movedIn: new Set<number>() };
    const mixed = [
      { type: "context", content: "" },
      { type: "del", content: "  );" },
      { type: "context", content: "}" },
      { type: "add", content: "  return total;" },
    ];
    expect(unifiedMoveCandidates(mixed, idx, moves, "in")).toEqual([
      { candidate: false, bridge: true },
      { candidate: false, bridge: true },
      { candidate: false, bridge: true },
      { candidate: false },
    ]);
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

  it("a real, non-moved line on the other side blocks the pair: still in the run, never hidden", () => {
    const idx = { removedIdx: [0], addedIdx: [undefined, 1] };
    const pairs = [{ leftType: "del" as const, leftUnifiedIndex: 0, rightType: "add" as const, rightUnifiedIndex: 1 }];
    // right side is an add row, but NOT in movedIn — a genuinely new line.
    const out = splitMoveCandidates(pairs, idx, { movedOut: new Set([0]), movedIn: new Set() }, "out");
    expect(out[0]).toEqual({ candidate: true, contentIdx: 0, blocked: true });
  });

  it("symmetric check for kind 'in': a real line on the left blocks it", () => {
    const idx = { removedIdx: [0], addedIdx: [undefined, 1] };
    const pairs = [{ leftType: "del" as const, leftUnifiedIndex: 0, rightType: "add" as const, rightUnifiedIndex: 1 }];
    const out = splitMoveCandidates(pairs, idx, { movedOut: new Set(), movedIn: new Set([1]) }, "in");
    expect(out[0]).toEqual({ candidate: true, contentIdx: 1, blocked: true });
  });

  it("a filler (null) cell on the left never breaks an 'in' pairing", () => {
    const idx = { removedIdx: [], addedIdx: [0] };
    const pairs = [{ rightType: "add" as const, rightUnifiedIndex: 0 }];
    const out = splitMoveCandidates(pairs, idx, { movedOut: new Set(), movedIn: new Set([0]) }, "in");
    expect(out[0].candidate).toBe(true);
  });

  it("a non-candidate pair is bridgeable only when both halves are blank or punctuation", () => {
    const idx = { removedIdx: [undefined], addedIdx: [undefined] };
    const moves = { movedOut: new Set<number>(), movedIn: new Set<number>() };
    const brace = { leftType: "context", leftUnifiedIndex: 0, leftContent: "}", rightType: "context", rightUnifiedIndex: 0, rightContent: "}" };
    const halfReal = { leftType: "del", leftUnifiedIndex: 0, leftContent: ")", rightType: "add", rightUnifiedIndex: 0, rightContent: "  return total;" };
    const blankOnly = { rightType: "add", rightUnifiedIndex: 0, rightContent: "" };
    expect(splitMoveCandidates([brace, halfReal, blankOnly], idx, moves, "out")).toEqual([
      { candidate: false, bridge: true },
      { candidate: false },
      { candidate: false, bridge: true },
    ]);
  });
});

describe("foldLabel", () => {
  const at = (path: string, lines?: [number, number], hunkId = "h"): MoveTarget =>
    lines ? { path, hunkId, side: "RIGHT", lines } : { path, hunkId, side: "RIGHT" };

  it("names the file and the lines at the other end", () => {
    expect(foldLabel("in", 39, [at("internal/browser/manager.go", [120, 158])])).toBe(
      "39 lines moved from internal/browser/manager.go:120–158",
    );
    expect(foldLabel("out", 39, [at("sandbox_runtime.go", [12, 50])])).toBe("39 lines moved to sandbox_runtime.go:12–50");
  });

  it("a single line is one number, and unknown lines leave the bare path", () => {
    expect(foldLabel("out", 1, [at("a.go", [7, 7])])).toBe("1 line moved to a.go:7");
    expect(foldLabel("out", 5, [at("a.go")])).toBe("5 lines moved to a.go");
  });

  it("two places in one file list both ranges", () => {
    expect(foldLabel("in", 9, [at("a.go", [1, 4], "h1"), at("a.go", [30, 34], "h2")])).toBe(
      "9 lines moved from a.go:1–4, 30–34",
    );
  });

  it("summarizes several files by count instead of listing them", () => {
    expect(foldLabel("in", 12, [at("a.go", [1, 6]), at("b.go", [2, 7])])).toBe("12 lines moved from 2 files");
  });

  it("says only that it moved when there is no other end", () => {
    expect(foldLabel("in", 4, [])).toBe("4 lines moved");
  });
});

describe("moveTargets", () => {
  const runs: MoveRun[] = [
    { path: "src/new.ts", hunkId: "hN", direction: "out", here: [0, 1, 2], there: [10, 11, 12] },
    { path: "src/new.ts", hunkId: "hN", direction: "out", here: [5, 6, 7], there: [20, 21, 22] },
    { path: "src/old.ts", hunkId: "hO", direction: "in", here: [0, 1, 2], there: [3, 4, 5] },
  ];
  // line = 100 + content index on the new side, 500 + on the old
  const locate: LocateMoved = (_hunkId, side, idx) => {
    const base = side === "RIGHT" ? 100 : 500;
    return [base + Math.min(...idx), base + Math.max(...idx)];
  };

  it("one target per other hunk, its lines spanning every run that went there", () => {
    expect(moveTargets(runs, "out", locate)).toEqual([
      { path: "src/new.ts", hunkId: "hN", side: "RIGHT", lines: [110, 122] },
    ]);
  });

  it("code that arrived is read on the old side there", () => {
    expect(moveTargets(runs, "in", locate)).toEqual([{ path: "src/old.ts", hunkId: "hO", side: "LEFT", lines: [503, 505] }]);
  });

  it("with `here`, only the runs a region holds count", () => {
    expect(moveTargets(runs, "out", locate, (i) => i >= 5)).toEqual([
      { path: "src/new.ts", hunkId: "hN", side: "RIGHT", lines: [120, 122] },
    ]);
  });

  it("without a locator the lines are left out", () => {
    expect(moveTargets(runs, "in")).toEqual([{ path: "src/old.ts", hunkId: "hO", side: "LEFT" }]);
  });

  it("targetLabel reads path:lines, with the path it is given", () => {
    const [t] = moveTargets(runs, "out", locate);
    expect(targetLabel(t)).toBe("src/new.ts:110–122");
    expect(targetLabel(t, "new.ts")).toBe("new.ts:110–122");
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
      runs: [{ path: "src/a.go", hunkId: "h0", direction: "in", here: [5, 6, 7, 8], there: [0, 1, 2, 3] }],
      locate: () => [40, 43],
    });
    expect(regions).toEqual([
      {
        key: "h1:in:5",
        kind: "in",
        from: 0,
        to: 4,
        hidden: 4,
        exempt: false,
        label: "4 lines moved from src/a.go:40–43",
        contentFrom: 5,
        contentTo: 8,
        targets: [{ path: "src/a.go", hunkId: "h0", side: "LEFT", lines: [40, 43] }],
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
      runs: [],
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
      runs: [],
    });
    expect(region.exempt).toBe(true);
  });

  it("split mode: a run with one blocked pair keeps one band that never folds, not two half bands", () => {
    // Six moved-out rows; the third pairs with a real added line on the right.
    // Before, that pair broke the run into 2 + 3 (neither long enough here,
    // but with a longer block: a band above the pair, rows, a band below).
    const candidates: MoveCandidate[] = [
      { candidate: true, contentIdx: 0 },
      { candidate: true, contentIdx: 1 },
      { candidate: true, contentIdx: 2, blocked: true },
      { candidate: true, contentIdx: 3 },
      { candidate: true, contentIdx: 4 },
      { candidate: true, contentIdx: 5 },
      { candidate: true, contentIdx: 6 },
      { candidate: true, contentIdx: 7 },
    ];
    const regions = moveFoldRegions({
      hunkId: "h1",
      kind: "out",
      candidates,
      exempt: candidates.map(() => false),
      runs: [],
    });
    expect(regions.map((r) => [r.key, r.from, r.to, r.exempt])).toEqual([["h1:out:0", 0, 8, true]]);
  });

  it("split mode: a blocked pair in one run leaves a separate, whole run foldable", () => {
    const run = (from: number, blocked = false): MoveCandidate[] =>
      [0, 1, 2, 3].map((i) => ({ candidate: true, contentIdx: from + i, ...(blocked && i === 1 ? { blocked: true } : {}) }));
    const candidates: MoveCandidate[] = [
      ...run(0, true),
      { candidate: false, contentIdx: undefined },
      ...run(10),
    ];
    const regions = moveFoldRegions({
      hunkId: "h1",
      kind: "in",
      candidates,
      exempt: candidates.map(() => false),
      runs: [],
    });
    expect(regions.map((r) => [r.key, r.exempt])).toEqual([
      ["h1:in:0", true],
      ["h1:in:10", false],
    ]);
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
      runs: [],
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

describe("folding and unfolding a region through its band", () => {
  // Mirrors DiffPane: the rows memo draws a band at every region's start,
  // folded or not; the band's click flips the region against the setting's
  // default, and the next rows pass reads that back by region key.
  const [region] = moveFoldRegions({
    hunkId: "h1",
    kind: "in",
    candidates: [5, 6, 7, 8].map((contentIdx) => ({ candidate: true, contentIdx })),
    exempt: [false, false, false, false],
    runs: [],
  });

  it("follows the default until the reader flips it", () => {
    expect(isFoldRegionFolded(region, new Set(), false)).toBe(false);
    expect(isFoldRegionFolded(region, new Set(), true)).toBe(true);
    expect(isFoldRegionFolded(region, new Set([region.key]), false)).toBe(true);
    expect(isFoldRegionFolded(region, new Set([region.key]), true)).toBe(false);
  });

  it("flips by region key, not the band's row key (regression)", () => {
    const band = foldPlaceholder(region, false);
    expect(band.key).not.toBe(region.key);
    const flipped = toggleFoldRegionKey(new Set(), band.regionKey);
    expect(isFoldRegionFolded(region, flipped, false)).toBe(true);
    expect(isFoldRegionFolded(region, toggleFoldRegionKey(flipped, band.regionKey), false)).toBe(false);
    // and it survives the pane's prune pass while its hunk is still shown
    expect(pruneOpenedFoldRegions(flipped, ["h1"])).toBe(flipped);
  });

  it("setFoldRegionFolded lands on the state asked for, whatever the default", () => {
    for (const byDefault of [false, true]) {
      for (const folded of [false, true]) {
        const next = setFoldRegionFolded(new Set(), region.key, folded, byDefault);
        expect(isFoldRegionFolded(region, next, byDefault)).toBe(folded);
        expect(setFoldRegionFolded(next, region.key, folded, byDefault)).toBe(next);
      }
    }
  });

  it("an exempt region never folds, but still has its band", () => {
    const exempt = { ...region, exempt: true };
    expect(isFoldRegionFolded(exempt, new Set(), true)).toBe(false);
    expect(foldBandsAt([exempt]).get(0)).toEqual([exempt]);
    expect(foldPlaceholder(exempt, false).exempt).toBe(true);
  });

  it("bands starting on the same row put the moved-out one first", () => {
    const out = { ...region, key: "h1:out:0", kind: "out" as const };
    expect(foldBandsAt([region, out]).get(0)?.map((r) => r.kind)).toEqual(["out", "in"]);
  });
});

describe("foldRegionHunkId", () => {
  it("parses the hunk id from the right, so ids containing a colon survive", () => {
    expect(foldRegionHunkId("h1:in:5")).toBe("h1");
    expect(foldRegionHunkId("a:b:out:12")).toBe("a:b");
    expect(pruneOpenedFoldRegions(new Set(["a:b:out:12"]), ["a:b"])).toEqual(new Set(["a:b:out:12"]));
  });
});
