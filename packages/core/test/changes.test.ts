import { describe, expect, it } from "vitest";
import { changedUnits, changesWorthRefreshing, renderChanges } from "../src/changes.js";
import { fold, liveUnits } from "../src/reducer.js";
import { truncateFindings } from "../src/service.js";
import {
  AnalysisSchema,
  CHANGELOG_TEXT_MAX,
  ReviewUnitPatchSchema,
  type FileDiff,
  type Hunk,
  type MigrationEntry,
  type ReviewerEvent,
} from "../src/schemas.js";

const ts = "2026-01-01T00:00:00.000Z";

function unit(id: string, hunkIds: string[], order: number) {
  return {
    id,
    title: id.toUpperCase(),
    summary: `${id} summary`,
    kind: "core-logic" as const,
    attention: "must-read" as const,
    attentionWhy: `${id} why`,
    riskFlags: [],
    hunkIds,
    order,
  };
}

/** r1: core = h1,h2 (a.ts); wire = h3 (b.ts); docs = h4 (c.ts). */
const base: ReviewerEvent[] = [
  {
    ts,
    type: "revision-added",
    revision: 1,
    baseSha: "base1",
    headSha: "head1",
    mergeBase: "mb1",
    baseOnly: false,
    files: [
      { path: "a.ts", hunkIds: ["h1", "h2"] },
      { path: "b.ts", hunkIds: ["h3"] },
      { path: "c.ts", hunkIds: ["h4"] },
    ],
  },
  {
    ts,
    type: "analysis-set",
    revision: 1,
    summary: "s",
    unassigned: [],
    units: [unit("core", ["h1", "h2"], 0), unit("wire", ["h3"], 1), unit("docs", ["h4"], 2)],
  },
];

const fileOf: Record<string, string> = { h1: "a.ts", h2: "a.ts", h3: "b.ts", h4: "c.ts" };

/**
 * r2 from explicit entries. Every old hunk not mentioned carries `identical`.
 */
function rev2(entries: MigrationEntry[], opts: { baseOnly?: boolean; n?: number } = {}): ReviewerEvent {
  const n = opts.n ?? 2;
  const mentioned = new Set(entries.flatMap((e) => [e.previousHunkId ?? "", e.status === "archived" ? e.hunkId : ""]));
  const carried: MigrationEntry[] = Object.keys(fileOf)
    .filter((id) => !mentioned.has(id))
    .map((id) => ({ status: "identical", hunkId: id, previousHunkId: id, file: fileOf[id] }));
  const all = [...carried, ...entries];
  const live = all.filter((e) => e.status !== "archived");
  const byFile = new Map<string, string[]>();
  for (const e of live) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e.hunkId]);
  const counts = { identical: 0, fuzzy: 0, renamed: 0, archived: 0, new: 0 };
  for (const e of all) counts[e.status]++;
  return {
    ts,
    type: "revision-added",
    revision: n,
    baseSha: `base${n}`,
    headSha: opts.baseOnly ? "head1" : `head${n}`,
    mergeBase: `mb${n}`,
    baseOnly: opts.baseOnly ?? false,
    files: [...byFile].map(([path, hunkIds]) => ({ path, hunkIds })),
    migration: { revision: n, previousRevision: n - 1, baseOnly: opts.baseOnly ?? false, counts, entries: all },
  };
}

function reportOf(e: ReviewerEvent) {
  if (e.type !== "revision-added" || !e.migration) throw new Error("no migration");
  return e.migration;
}

const fuzzyH1: MigrationEntry = { status: "fuzzy", hunkId: "h1b", previousHunkId: "h1", file: "a.ts", score: 0.8 };

function hunk(id: string, file: string, added: string[]): Hunk {
  return {
    id,
    file,
    oldStart: 1,
    oldLines: 0,
    newStart: 1,
    newLines: added.length,
    header: "",
    addedLines: added,
    removedLines: [],
    text: added.map((l) => `+${l}`).join("\n"),
  };
}
const fd = (path: string, hunks: Hunk[]): FileDiff => ({ path, status: "modified", binary: false, hunks });

describe("changedUnits", () => {
  it("flags a unit whose hunk migrated fuzzy, and nothing else", () => {
    const ev = rev2([fuzzyH1]);
    const state = fold([...base, ev]);
    const changes = changedUnits(state, reportOf(ev));
    expect(changes.map((c) => c.unit.id)).toEqual(["core"]);
    expect(changes[0].reworked.map((e) => e.hunkId)).toEqual(["h1b"]);
    expect(changes[0]).toMatchObject({ archived: [], gained: [], baseOnly: false });
  });

  it("flags a renamed hunk only when its content changed", () => {
    const renamed: MigrationEntry = {
      status: "renamed",
      hunkId: "h3r",
      previousHunkId: "h3",
      file: "b2.ts",
      previousFile: "b.ts",
    };
    const ev = rev2([renamed]);
    const state = fold([...base, ev]);
    const prev = [fd("b.ts", [hunk("h3", "b.ts", ["x = 1"])])];
    const changed = [fd("b2.ts", [hunk("h3r", "b2.ts", ["x = 2"])])];
    const same = [fd("b2.ts", [hunk("h3r", "b2.ts", ["x = 1"])])];
    const report = reportOf(ev);
    expect(changedUnits(state, report, { previousFiles: prev, currentFiles: changed }).map((c) => c.unit.id)).toEqual([
      "wire",
    ]);
    expect(changedUnits(state, report, { previousFiles: prev, currentFiles: same })).toEqual([]);
    // Without bodies a renamed hunk is taken as identical (what migrate emits).
    expect(changedUnits(state, report)).toEqual([]);
  });

  it("flags a unit that lost a hunk to archived, remembering the unit on state.archived", () => {
    const ev = rev2([{ status: "archived", hunkId: "h2", file: "a.ts" }]);
    const state = fold([...base, ev]);
    expect(state.archived).toEqual([
      expect.objectContaining({ hunkId: "h2", archivedAtRevision: 2, unitId: "core" }),
    ]);
    const changes = changedUnits(state, reportOf(ev));
    expect(changes.map((c) => c.unit.id)).toEqual(["core"]);
    expect(changes[0].archived.map((e) => e.hunkId)).toEqual(["h2"]);
  });

  it("returns nothing for a revision that left every unit untouched", () => {
    const ev = rev2([]);
    expect(changedUnits(fold([...base, ev]), reportOf(ev))).toEqual([]);
    expect(changedUnits(fold(base), undefined)).toEqual([]);
  });

  it("ignores husks", () => {
    // docs' only hunk leaves the PR: docs becomes a husk, not a changed unit.
    const ev = rev2([{ status: "archived", hunkId: "h4", file: "c.ts" }]);
    const state = fold([...base, ev]);
    expect(liveUnits(state).map((u) => u.id)).not.toContain("docs");
    expect(changedUnits(state, reportOf(ev))).toEqual([]);
  });

  it("flags baseOnly revisions, and only archive/gain changes are worth a run there", () => {
    const fuzzyOnly = rev2([fuzzyH1], { baseOnly: true });
    const c1 = changedUnits(fold([...base, fuzzyOnly]), reportOf(fuzzyOnly));
    expect(c1).toHaveLength(1);
    expect(c1[0].baseOnly).toBe(true);
    expect(changesWorthRefreshing(c1)).toEqual([]);

    // core loses h2 as well as reworking h1: the archive makes it worth a run.
    const withArchive = rev2([fuzzyH1, { status: "archived", hunkId: "h2", file: "a.ts" }], { baseOnly: true });
    const c2 = changedUnits(fold([...base, withArchive]), reportOf(withArchive));
    expect(changesWorthRefreshing(c2).map((c) => c.unit.id)).toEqual(["core"]);
    // Not baseOnly: fuzzy alone is worth it.
    const plain = rev2([fuzzyH1]);
    expect(changesWorthRefreshing(changedUnits(fold([...base, plain]), reportOf(plain)))).toHaveLength(1);
  });

  it("flags a unit once the analysis attaches a new hunk to it", () => {
    const ev = rev2([{ status: "new", hunkId: "h5", file: "b.ts" }]);
    const before = fold([...base, ev]);
    expect(changedUnits(before, reportOf(ev))).toEqual([]);
    const after = fold([
      ...base,
      ev,
      { ts, type: "unit-updated", unitId: "wire", patch: { hunkIds: ["h3", "h5"] } },
    ]);
    const changes = changedUnits(after, reportOf(ev));
    expect(changes.map((c) => c.unit.id)).toEqual(["wire"]);
    expect(changes[0].gained.map((e) => e.hunkId)).toEqual(["h5"]);
  });
});

describe("renderChanges", () => {
  it("prints the none line when nothing changed", () => {
    const ev = rev2([]);
    const out = renderChanges({ state: fold([...base, ev]), report: reportOf(ev), revision: 2 });
    expect(out.body).toBe("No units changed in revision 2.\n");
    expect(out.count).toBe(0);
  });

  it("shows description, a compact before->after, archived sizes and related hints", () => {
    const ev = rev2([
      fuzzyH1,
      { status: "archived", hunkId: "h2", file: "a.ts" },
      { status: "new", hunkId: "h6", file: "a.ts" },
    ]);
    const state = fold([...base, ev]);
    const ctx = Array.from({ length: 10 }, (_, i) => `ctx${i}`);
    const out = renderChanges({
      state,
      report: reportOf(ev),
      revision: 2,
      previousFiles: [fd("a.ts", [hunk("h1", "a.ts", [...ctx, "round(x)"]), hunk("h2", "a.ts", ["gone", "gone2"])])],
      currentFiles: [fd("a.ts", [hunk("h1b", "a.ts", [...ctx, "bankersRound(x)"]), hunk("h6", "a.ts", ["fresh"])])],
    });
    expect(out.body).toContain("## core — CORE  [must-read/core-logic]");
    expect(out.body).toContain("summary: core summary");
    expect(out.body).toContain("attentionWhy: core why");
    expect(out.body).toContain("~ fuzzy score 0.80: h1b <- h1  a.ts  +11 -0 -> +11 -0");
    expect(out.body).toContain("    was│+round(x)");
    expect(out.body).toContain("    now│+bankersRound(x)");
    // compact: only one line of context before the change, not the whole body
    expect(out.body).toContain("       │+ctx9");
    expect(out.body).not.toContain("ctx0");
    expect(out.body).toContain("- archived: h2  a.ts  +2 -0");
    expect(out.body).toContain("? related (unassigned, hint only): h6  a.ts  +1 -0");
    expect(out.summary).toBe("-- 1 changed unit: 1 reworked hunks, 1 archived, 1 related hints");
  });
});

describe("unit changelog through the reducer", () => {
  const entryPatch = (text: string): ReviewerEvent => ({
    ts,
    type: "unit-updated",
    unitId: "core",
    patch: { summary: "new summary", changelogEntry: text },
  });

  it("adds an entry under the current revision and replaces it on a re-run", () => {
    const ev = rev2([fuzzyH1]);
    const once = fold([...base, ev, entryPatch("first take")]);
    const core = once.units.find((u) => u.id === "core")!;
    expect(core.changelog).toEqual([{ revision: 2, text: "first take" }]);
    expect(core.summary).toBe("new summary");
    expect("changelogEntry" in core).toBe(false);

    const twice = fold([...base, ev, entryPatch("first take"), entryPatch("second take")]);
    expect(twice.units.find((u) => u.id === "core")!.changelog).toEqual([{ revision: 2, text: "second take" }]);
  });

  it("keeps the changelog through later migrations and on husks", () => {
    const r2 = rev2([fuzzyH1]);
    const r3 = rev2([{ status: "fuzzy", hunkId: "h1c", previousHunkId: "h1b", file: "a.ts" }], { n: 3 });
    // r3's helper carries h1..h4 by default; h1 was renamed to h1b in r2, so
    // it references ids that no longer exist — harmless for this check.
    const s = fold([...base, r2, entryPatch("r2 change"), r3, entryPatch("r3 change")]);
    expect(s.units.find((u) => u.id === "core")!.changelog).toEqual([
      { revision: 2, text: "r2 change" },
      { revision: 3, text: "r3 change" },
    ]);

    // Every hunk of core leaves in r3: the husk keeps what it said, changelog included.
    const drop = rev2(
      [
        { status: "archived", hunkId: "h1b", file: "a.ts" },
        { status: "archived", hunkId: "h2", file: "a.ts" },
      ],
      { n: 3 },
    );
    const husk = fold([...base, r2, entryPatch("r2 change"), drop]).units.find((u) => u.id === "core")!;
    expect(husk.removedAtRevision).toBe(3);
    expect(husk.changelog).toEqual([{ revision: 2, text: "r2 change" }]);
  });

  it("starts fresh on analysis-set unless the payload carries it", () => {
    const s = fold([...base, rev2([fuzzyH1]), entryPatch("r2 change"), base[1]]);
    expect(s.units.find((u) => u.id === "core")!.changelog).toBeUndefined();
  });

  it("validates: set-analysis accepts changelog; the patch caps changelogEntry at the sanity limit", () => {
    const parsed = AnalysisSchema.parse({
      summary: "s",
      units: [{ ...unit("core", ["h1"], 0), changelog: [{ revision: 2, text: "x" }] }],
    });
    expect(parsed.units[0].changelog).toEqual([{ revision: 2, text: "x" }]);
    expect(ReviewUnitPatchSchema.safeParse({ changelogEntry: "x".repeat(CHANGELOG_TEXT_MAX + 1) }).success).toBe(false);
    expect(ReviewUnitPatchSchema.safeParse({ changelogEntry: "x".repeat(CHANGELOG_TEXT_MAX) }).success).toBe(true);
    // A real-sized note (the kind the old 160-char cap clipped) passes whole.
    const note = "summary/attentionWhy rewritten for per-policy previousEnd checks; tests cover a policy that disappears and reappears in a new management batch";
    expect(truncateFindings({ changelogEntry: note }, "core")).toEqual({ payload: { changelogEntry: note }, warnings: [] });
  });

  it("truncateFindings clips an over-long changelogEntry at a word boundary with a warning", () => {
    const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const { payload, warnings } = truncateFindings({ changelogEntry: long }, "core");
    const text = (payload as { changelogEntry: string }).changelogEntry;
    expect(text.length).toBeLessThanOrEqual(CHANGELOG_TEXT_MAX);
    expect(text.endsWith("…")).toBe(true);
    expect(text.slice(0, -1)).toMatch(/word\d+$/);
    expect(warnings).toEqual([
      `warning: unit core changelogEntry truncated (${long.length}->${CHANGELOG_TEXT_MAX} chars)`,
    ]);
    expect(ReviewUnitPatchSchema.safeParse(payload).success).toBe(true);
  });
});
