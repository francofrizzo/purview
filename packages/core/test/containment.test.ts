import { describe, expect, it } from "vitest";
import { renderChanges } from "../src/changes.js";
import { computeHunkId } from "../src/hunk-id.js";
import { computeRevisionLineChanges } from "../src/line-changes.js";
import {
  CONTAINMENT_THRESHOLD,
  containment,
  formatMigrationReport,
  migrate,
  toRevisionFiles,
} from "../src/migration.js";
import { fold } from "../src/reducer.js";
import {
  MigrationReportSchema,
  type FileDiff,
  type Hunk,
  type HunkState,
  type ReviewerEvent,
} from "../src/schemas.js";

/**
 * Containment matching: a rebase re-cuts hunk boundaries, so one old hunk
 * splits into two new ones, or two merge into one. Jaccard misses both; the
 * containment pass (migration.ts) gives each piece its predecessor.
 */

const ts = "2026-01-01T00:00:00.000Z";

/** `n` distinct, meaningful lines (unique tokens per line, so token Jaccard can't blur them). */
function code(prefix: string, n: number, from = 0): string[] {
  return Array.from({ length: n }, (_, i) => `const ${prefix}${from + i} = compute${prefix}${from + i}(input);`);
}

function mkHunk(file: string, added: string[], removed: string[] = []): Hunk {
  return {
    id: computeHunkId(file, added, removed),
    file,
    oldStart: 1,
    oldLines: removed.length,
    newStart: 1,
    newLines: added.length,
    header: "",
    addedLines: added,
    removedLines: removed,
    text: [...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join("\n"),
  };
}

function mkFile(path: string, hunks: Hunk[], oldPath?: string): FileDiff {
  return { path, oldPath, status: oldPath ? "renamed" : "modified", binary: false, hunks };
}

const entryOf = (report: ReturnType<typeof migrate>, id: string) =>
  report.entries.find((e) => e.hunkId === id && e.status !== "archived");

describe("containment()", () => {
  it("is the share of the new hunk's significant lines the old one has, added vs added, removed vs removed", () => {
    const old = mkHunk("a.ts", ["x = 1;", "y = 2;", "z = 3;"], ["w = 0;"]);
    expect(containment(mkHunk("a.ts", ["x = 1;", "y = 2;"]), old)).toMatchObject({ overlap: 2, total: 2, score: 1 });
    // A removed line never matches an added one.
    expect(containment(mkHunk("a.ts", [], ["x = 1;"]), old).score).toBe(0);
    // Multiset: a line the old hunk had once counts once.
    expect(containment(mkHunk("a.ts", ["x = 1;", "x = 1;"]), old)).toMatchObject({ overlap: 1, total: 2 });
    // Whitespace-insensitive, and punctuation-only lines are ignored on both sides.
    expect(containment(mkHunk("a.ts", ["    x = 1;", "}", "});", "  ]", ""]), old)).toMatchObject({
      overlap: 1,
      total: 1,
    });
  });
});

describe("migrate: containment pass", () => {
  it("split: one old hunk -> two new ones, both fuzzy with the same predecessor; the old one is not archived", () => {
    const old = mkHunk("a.ts", code("a", 16));
    const top = mkHunk("a.ts", code("a", 8));
    const bottom = mkHunk("a.ts", code("a", 8, 8));
    const report = migrate({
      revision: 2,
      previousRevision: 1,
      previousFiles: [mkFile("a.ts", [old])],
      nextFiles: [mkFile("a.ts", [top, bottom])],
      hunkStates: { [old.id]: { viewed: true, changedSinceViewed: false } },
    });
    expect(report.counts).toMatchObject({ fuzzy: 2, archived: 0, new: 0 });
    for (const h of [top, bottom]) {
      expect(entryOf(report, h.id)).toMatchObject({
        status: "fuzzy",
        previousHunkId: old.id,
        match: "containment",
        score: 1,
        wasViewed: true,
        // content differs from the whole it came from
        changedSinceViewed: true,
      });
    }
    expect(formatMigrationReport(report)).toContain("contained=1.00");
  });

  it("split where the bigger half still Jaccard-matches: the smaller half reuses the same predecessor", () => {
    const old = mkHunk("a.ts", code("a", 16));
    const big = mkHunk("a.ts", code("a", 11));
    const small = mkHunk("a.ts", code("a", 5, 11));
    const report = migrate({
      revision: 2,
      previousRevision: 1,
      previousFiles: [mkFile("a.ts", [old])],
      nextFiles: [mkFile("a.ts", [big, small])],
    });
    expect(entryOf(report, big.id)).toMatchObject({ status: "fuzzy", previousHunkId: old.id });
    expect(entryOf(report, big.id)?.match).toBeUndefined();
    expect(entryOf(report, small.id)).toMatchObject({ status: "fuzzy", previousHunkId: old.id, match: "containment" });
    expect(report.counts.archived).toBe(0);
  });

  it("merge: two old -> one new; the larger contributor is the predecessor, the other is archived", () => {
    // 8 of P's 12 lines + all 4 of Q's: Jaccard vs P is 8/16 = 0.5, containment 8/12.
    const p = mkHunk("a.ts", code("p", 12));
    const q = mkHunk("a.ts", code("q", 4));
    const merged = mkHunk("a.ts", [...code("p", 8), ...code("q", 4)]);
    const report = migrate({
      revision: 2,
      previousRevision: 1,
      previousFiles: [mkFile("a.ts", [p, q])],
      nextFiles: [mkFile("a.ts", [merged])],
    });
    expect(entryOf(report, merged.id)).toMatchObject({ status: "fuzzy", previousHunkId: p.id, match: "containment" });
    expect(entryOf(report, merged.id)?.score).toBeCloseTo(8 / 12);
    expect(report.entries.filter((e) => e.status === "archived").map((e) => e.hunkId)).toEqual([q.id]);
  });

  it("never containment-matches a hunk with fewer than 3 significant lines; brace-only lines don't count", () => {
    const old = mkHunk("a.ts", [...code("a", 16), "}", "});", "]"]);
    const big = mkHunk("a.ts", code("a", 14));
    // Two real lines plus punctuation the old hunk also had: still too small.
    const tiny = mkHunk("a.ts", [...code("a", 2, 14), "}", "});", "]"]);
    const report = migrate({
      revision: 2,
      previousRevision: 1,
      previousFiles: [mkFile("a.ts", [old])],
      nextFiles: [mkFile("a.ts", [big, tiny])],
    });
    expect(entryOf(report, big.id)?.status).toBe("fuzzy");
    expect(entryOf(report, tiny.id)?.status).toBe("new");
  });

  it("brace-only lines the old hunk lacked do not dilute containment", () => {
    const old = mkHunk("a.ts", code("a", 16));
    const big = mkHunk("a.ts", code("a", 13));
    const piece = mkHunk("a.ts", [...code("a", 3, 13), "}", "}", ")", "{", "},", "];"]);
    const report = migrate({
      revision: 2,
      previousRevision: 1,
      previousFiles: [mkFile("a.ts", [old])],
      nextFiles: [mkFile("a.ts", [big, piece])],
    });
    expect(entryOf(report, piece.id)).toMatchObject({ previousHunkId: old.id, match: "containment", score: 1 });
  });

  it("stays new below the containment threshold", () => {
    const old = mkHunk("a.ts", code("a", 16));
    const big = mkHunk("a.ts", code("a", 11));
    const half = mkHunk("a.ts", [...code("a", 5, 11), ...code("fresh", 5)]);
    expect(containment(half, old).score).toBeLessThan(CONTAINMENT_THRESHOLD);
    const report = migrate({
      revision: 2,
      previousRevision: 1,
      previousFiles: [mkFile("a.ts", [old])],
      nextFiles: [mkFile("a.ts", [big, half])],
    });
    expect(entryOf(report, half.id)?.status).toBe("new");
  });

  it("only looks in the same file, rename-aware", () => {
    const old = mkHunk("old.ts", code("a", 16));
    const top = mkHunk("new.ts", code("a", 8));
    const bottom = mkHunk("new.ts", code("a", 8, 8));
    const elsewhere = mkHunk("other.ts", code("a", 8));
    const report = migrate({
      revision: 2,
      previousRevision: 1,
      previousFiles: [mkFile("old.ts", [old])],
      nextFiles: [mkFile("new.ts", [top, bottom], "old.ts"), mkFile("other.ts", [elsewhere])],
    });
    expect(entryOf(report, top.id)).toMatchObject({ previousHunkId: old.id, previousFile: "old.ts", match: "containment" });
    expect(entryOf(report, bottom.id)).toMatchObject({ previousHunkId: old.id, match: "containment" });
    expect(entryOf(report, elsewhere.id)?.status).toBe("new");
  });

  it("an old report without `match` still parses", () => {
    const parsed = MigrationReportSchema.parse({
      revision: 2,
      counts: { identical: 0, fuzzy: 1, renamed: 0, archived: 0, new: 0 },
      entries: [{ status: "fuzzy", hunkId: "b", previousHunkId: "a", file: "a.ts", score: 0.7 }],
    });
    expect(parsed.entries[0].match).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ reducer */

function revisionEvent(n: number, files: FileDiff[], migration?: ReturnType<typeof migrate>): ReviewerEvent {
  return {
    ts,
    type: "revision-added",
    revision: n,
    baseSha: `base${n}`,
    headSha: `head${n}`,
    mergeBase: `mb${n}`,
    baseOnly: false,
    files: toRevisionFiles(files),
    migration,
  };
}

function unit(id: string, hunkIds: string[], order: number) {
  return {
    id,
    title: id,
    summary: `${id} summary`,
    kind: "core-logic" as const,
    attention: "must-read" as const,
    attentionWhy: "why",
    riskFlags: [],
    hunkIds,
    order,
    findings: [{ severity: "note" as const, text: `${id} finding`, evidence: "a.ts:1" }],
  };
}

/** r1 -> r2 through the real migrate(), folded. */
function twoRevisions(
  r1: FileDiff[],
  r2: FileDiff[],
  units: ReturnType<typeof unit>[],
  extra: ReviewerEvent[] = [],
) {
  const ev1 = revisionEvent(1, r1);
  const setup: ReviewerEvent[] = [
    ev1,
    { ts, type: "analysis-set", revision: 1, summary: "s", unassigned: [], units },
    ...extra,
  ];
  const before = fold(setup);
  const report = migrate({
    revision: 2,
    previousRevision: 1,
    previousFiles: r1,
    nextFiles: r2,
    hunkStates: before.hunks as Record<string, HunkState>,
  });
  const ev2 = revisionEvent(2, r2, report);
  return { state: fold([...setup, ev2]), report };
}

describe("reducer: containment successors", () => {
  const old = mkHunk("a.ts", code("a", 16));
  const other = mkHunk("a.ts", code("o", 6));
  const top = mkHunk("a.ts", code("a", 8));
  const bottom = mkHunk("a.ts", code("a", 8, 8));

  it("split: the unit keeps both halves, in new-revision order at the old hunk's place", () => {
    const { state } = twoRevisions(
      [mkFile("a.ts", [old, other])],
      // the new file lists `bottom` first
      [mkFile("a.ts", [bottom, other, top])],
      [unit("core", [old.id, other.id], 0)],
    );
    expect(state.units[0].hunkIds).toEqual([bottom.id, top.id, other.id]);
    expect(state.archived).toEqual([]);
    expect(state.hunks[top.id]).toMatchObject({ predecessorId: old.id, migration: "fuzzy" });
    expect(state.hunks[bottom.id]).toMatchObject({ predecessorId: old.id, migration: "fuzzy" });
  });

  it("viewed state carries to every successor, flagged changed-since-viewed; findings are dropped as for fuzzy", () => {
    const { state } = twoRevisions(
      [mkFile("a.ts", [old])],
      [mkFile("a.ts", [top, bottom])],
      [unit("core", [old.id], 0)],
      [{ ts, type: "hunk-viewed", hunkId: old.id, revision: 1 }],
    );
    for (const id of [top.id, bottom.id]) {
      expect(state.hunks[id]).toMatchObject({ changedSinceViewed: true, viewed: false, viewedAtRevision: 1 });
    }
    expect(state.units[0].findings).toBeUndefined();
  });

  it("an old hunk carried identical AND split off another piece still drops the unit's findings", () => {
    // `old` stays byte-identical; a new hunk elsewhere in the file repeats most of it.
    const copy = mkHunk("a.ts", [...code("a", 4), "fresh();"]);
    const { state, report } = twoRevisions(
      [mkFile("a.ts", [old])],
      [mkFile("a.ts", [old, copy])],
      [unit("core", [old.id], 0)],
    );
    expect(entryOf(report, copy.id)).toMatchObject({ previousHunkId: old.id, match: "containment" });
    expect(state.units[0].hunkIds).toEqual([old.id, copy.id]);
    expect(state.units[0].findings).toBeUndefined();
  });

  it("merge across two units: the recorded predecessor's unit takes the hunk, the other loses it", () => {
    const p = mkHunk("a.ts", code("p", 12));
    const q = mkHunk("a.ts", code("q", 4));
    const keep = mkHunk("b.ts", code("k", 6));
    const merged = mkHunk("a.ts", [...code("p", 8), ...code("q", 4)]);
    const { state } = twoRevisions(
      [mkFile("a.ts", [p, q]), mkFile("b.ts", [keep])],
      [mkFile("a.ts", [merged]), mkFile("b.ts", [keep])],
      [unit("big", [p.id], 0), unit("small", [q.id], 1), unit("side", [keep.id], 2)],
    );
    const holders = state.units.filter((u) => u.hunkIds.includes(merged.id)).map((u) => u.id);
    expect(holders).toEqual(["big"]);
    const small = state.units.find((u) => u.id === "small")!;
    expect(small.hunkIds).toEqual([]);
    expect(small.removedAtRevision).toBe(2); // a husk, per the existing rules
    expect(state.archived.map((a) => [a.hunkId, a.unitId])).toEqual([[q.id, "small"]]);
  });
});

/* ------------------------------------------------------------------ changes */

describe("renderChanges: prior-code share of new hunks", () => {
  it("says how much of each remaining new hunk the previous revision's file already had", () => {
    const p = mkHunk("a.ts", code("p", 10));
    // 5 of its 10 lines were in r1 (below the containment threshold, so it stays `new`)
    const half = mkHunk("a.ts", [...code("p", 5), ...code("fresh", 5)]);
    const fresh = mkHunk("a.ts", code("brandnew", 6));
    const keep = mkHunk("a.ts", code("k", 6));
    const r1 = [mkFile("a.ts", [p, keep])];
    const r2 = [mkFile("a.ts", [half, fresh, keep])];
    const { state, report } = twoRevisions(r1, r2, [unit("core", [p.id, keep.id], 0)]);
    expect(entryOf(report, half.id)?.status).toBe("new");
    const out = renderChanges({ state, report, revision: 2, previousFiles: r1, currentFiles: r2 });
    expect(out.body).toContain(`? related (unassigned, hint only): ${half.id}  a.ts  +10 -0  (50% of its lines were already in r1)`);
    // under 20%: no note
    expect(out.body).toContain(`? related (unassigned, hint only): ${fresh.id}  a.ts  +6 -0\n`);
    // the archived hunk's code partly lives on
    expect(out.body).toContain(`- archived: ${p.id}  a.ts  +10 -0  (50% of its lines are still in r2)`);
    expect(out.summary).toContain("1 new hunks partly from r1");
  });

  it("lists them even when no unit changed", () => {
    const keep = mkHunk("a.ts", code("k", 6));
    const p = mkHunk("b.ts", code("p", 10));
    const half = mkHunk("b.ts", [...code("p", 5), ...code("fresh", 5)]);
    const r1 = [mkFile("a.ts", [keep]), mkFile("b.ts", [p])];
    const r2 = [mkFile("a.ts", [keep]), mkFile("b.ts", [p, half])];
    const { state, report } = twoRevisions(r1, r2, [unit("core", [keep.id], 0), unit("b", [p.id], 1)]);
    const out = renderChanges({ state, report, revision: 2, previousFiles: r1, currentFiles: r2 });
    expect(out.body).toContain("No units changed in revision 2.");
    expect(out.body).toContain(`  ${half.id}  b.ts  +10 -0  (50% of its lines were already in r1)`);
  });

  it("renders a split half without reporting the other half as removed", () => {
    const old = mkHunk("a.ts", code("a", 16));
    const top = mkHunk("a.ts", [...code("a", 8), "added();"]);
    const bottom = mkHunk("a.ts", code("a", 8, 8));
    const r1 = [mkFile("a.ts", [old])];
    const r2 = [mkFile("a.ts", [top, bottom])];
    const { state, report } = twoRevisions(r1, r2, [unit("core", [old.id], 0)]);
    const out = renderChanges({ state, report, revision: 2, previousFiles: r1, currentFiles: r2 });
    expect(out.body).toContain(`~ fuzzy (hunk boundaries moved: 89% of its lines were already in ${old.id}): ${top.id} <- ${old.id}`);
    expect(out.body).toContain(`(also continued in ${bottom.id})`);
    expect(out.body).toContain("    now│+added();");
    // a8..a15 moved to `bottom`: not a removal
    expect(out.body).not.toContain("was│+const a8");
    expect(out.body).toContain("    (same lines; only position/context moved)");
  });
});

/* ------------------------------------------------------------- line changes */

describe("revision line changes across a split", () => {
  it("forks into every successor and does not count the other half as rewritten", () => {
    // r1 -> r2: H gains a line. r2 -> r3: H splits into T and B.
    const h1 = mkHunk("a.ts", code("a", 16));
    const h2 = mkHunk("a.ts", [...code("a", 8), "added();", ...code("a", 8, 8)]);
    const t = mkHunk("a.ts", [...code("a", 8), "added();"]);
    const b = mkHunk("a.ts", code("a", 8, 8));
    const r2 = migrate({ revision: 2, previousRevision: 1, previousFiles: [mkFile("a.ts", [h1])], nextFiles: [mkFile("a.ts", [h2])] });
    const r3 = migrate({ revision: 3, previousRevision: 2, previousFiles: [mkFile("a.ts", [h2])], nextFiles: [mkFile("a.ts", [t, b])] });
    expect(entryOf(r3, t.id)?.previousHunkId).toBe(h2.id);
    expect(entryOf(r3, b.id)?.previousHunkId).toBe(h2.id);
    const out = computeRevisionLineChanges({
      revision: 2,
      currentRevision: 3,
      report: r2,
      revisionFiles: [mkFile("a.ts", [h2])],
      previousFiles: [mkFile("a.ts", [h1])],
      laterReports: [r3],
      currentFiles: [mkFile("a.ts", [t, b])],
    });
    const byId = new Map(out.hunks.map((h) => [h.currentHunkId, h]));
    expect(byId.get(t.id)).toMatchObject({ lines: [8], rewrittenSince: 0 });
    expect(byId.get(b.id)).toMatchObject({ lines: [], rewrittenSince: 0 });
    expect(out.goneCount).toBe(0);
  });

  it("a split half introduced by a revision marks only its genuinely new lines", () => {
    const old = mkHunk("a.ts", code("a", 16));
    const top = mkHunk("a.ts", [...code("a", 8), "added();"]);
    const bottom = mkHunk("a.ts", code("a", 8, 8));
    const r1 = [mkFile("a.ts", [old])];
    const r2 = [mkFile("a.ts", [top, bottom])];
    const report = migrate({ revision: 2, previousRevision: 1, previousFiles: r1, nextFiles: r2 });
    const out = computeRevisionLineChanges({
      revision: 2,
      currentRevision: 2,
      report,
      revisionFiles: r2,
      previousFiles: r1,
      laterReports: [],
      currentFiles: r2,
    });
    const byId = new Map(out.hunks.map((h) => [h.currentHunkId, h]));
    // top: only `added();`, no "8 lines removed" for what went to `bottom`
    expect(byId.get(top.id)).toMatchObject({ lines: [8], removedCount: 0, removedAt: [] });
    // bottom: nothing changed, so it is not reported at all
    expect(byId.has(bottom.id)).toBe(false);
  });
});
