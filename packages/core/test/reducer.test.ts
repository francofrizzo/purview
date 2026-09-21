import { describe, expect, it } from "vitest";
import {
  fold,
  lastReviewSubmission,
  liveUnits,
  readiness,
  removedUnits,
  unitProgress,
  viewedFiles,
} from "../src/reducer.js";
import type { MigrationEntry, ReviewerEvent } from "../src/schemas.js";

const ts = "2026-01-01T00:00:00.000Z";

const events: ReviewerEvent[] = [
  {
    ts,
    type: "pr-initialized",
    host: "github.com",
    owner: "acme",
    repo: "widgets",
    number: 7,
    url: "https://github.com/acme/widgets/pull/7",
    title: "Add widgets",
  },
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
    ],
  },
  {
    ts,
    type: "analysis-set",
    revision: 1,
    summary: "Adds widgets.",
    unassigned: [],
    units: [
      {
        id: "core",
        title: "Widget core",
        summary: "The logic.",
        kind: "core-logic",
        attention: "must-read",
        attentionWhy: "encodes pricing",
        riskFlags: ["money"],
        hunkIds: ["h1", "h2"],
        order: 0,
      },
      {
        id: "wire",
        title: "Wiring",
        summary: "Registers it.",
        kind: "wiring",
        attention: "skip",
        attentionWhy: "mechanical",
        riskFlags: [],
        hunkIds: ["h3"],
        order: 1,
      },
    ],
  },
];

describe("fold", () => {
  it("builds pr, revision and unit state", () => {
    const s = fold(events);
    expect(s.pr?.owner).toBe("acme");
    expect(s.currentRevision).toBe(1);
    expect(s.summary).toBe("Adds widgets.");
    expect(Object.keys(s.hunks).sort()).toEqual(["h1", "h2", "h3"]);
    expect(s.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(s.files[0].total).toBe(2);
  });

  it("rolls a file up as viewed only when all its hunks are viewed", () => {
    const partial = fold([
      ...events,
      { ts, type: "hunk-viewed", hunkId: "h1", revision: 1 },
    ]);
    expect(partial.files[0].viewed).toBe(false);
    expect(partial.files[0].viewedCount).toBe(1);
    expect(viewedFiles(partial)).toEqual([]);

    const full = fold([
      ...events,
      { ts, type: "hunk-viewed", hunkId: "h1", revision: 1 },
      { ts, type: "hunk-viewed", hunkId: "h2", revision: 1 },
    ]);
    expect(full.files[0].viewed).toBe(true);
    expect(viewedFiles(full)).toEqual(["a.ts"]);
  });

  it("expands unit-viewed to its hunks and computes progress", () => {
    const s = fold([...events, { ts, type: "unit-viewed", unitId: "core" }]);
    expect(s.hunks.h1.viewed).toBe(true);
    expect(s.hunks.h2.viewed).toBe(true);
    expect(s.hunks.h2.viewedAtRevision).toBe(1);
    expect(s.hunks.h3.viewed).toBe(false);
    const p = unitProgress(s);
    expect(p[0]).toMatchObject({ unitId: "core", viewed: 2, total: 2, complete: true });
    expect(p[1]).toMatchObject({ unitId: "wire", viewed: 0, complete: false });
  });

  it("unviews a hunk", () => {
    const s = fold([
      ...events,
      { ts, type: "hunk-viewed", hunkId: "h1", revision: 1 },
      { ts, type: "hunk-unviewed", hunkId: "h1", revision: 1 },
    ]);
    expect(s.hunks.h1.viewed).toBe(false);
    expect(s.hunks.h1.viewedAtRevision).toBeUndefined();
  });

  it("patches units and records classification corrections", () => {
    const s = fold([
      ...events,
      { ts, type: "unit-updated", unitId: "wire", patch: { attention: "must-read" } },
      {
        ts,
        type: "classification-corrected",
        hunkId: "h3",
        from: "skip",
        to: "must-read",
        note: "touches auth",
      },
    ]);
    expect(s.units.find((u) => u.id === "wire")!.attention).toBe("must-read");
    expect(s.units.find((u) => u.id === "wire")!.kind).toBe("wiring");
    expect(s.corrections).toHaveLength(1);
    expect(s.corrections[0].note).toBe("touches auth");
  });

  it("tracks github sync per file", () => {
    const s = fold([
      ...events,
      { ts, type: "file-synced-github", file: "b.ts", viewed: true },
    ]);
    expect(s.files.find((f) => f.path === "b.ts")!.syncedToGithub).toBe(true);
  });

  it("is deterministic: folding twice yields the same state", () => {
    expect(fold(events)).toEqual(fold(events));
  });

  describe("review-submitted", () => {
    it("records the submission with the revision it was made at", () => {
      const s = fold([
        ...events,
        {
          ts,
          type: "review-submitted",
          event: "APPROVE",
          url: "https://github.com/acme/widgets/pull/7#pullrequestreview-1",
          commentCount: 3,
        },
      ]);
      expect(s.reviewSubmissions).toHaveLength(1);
      expect(s.reviewSubmissions[0]).toEqual({
        event: "APPROVE",
        url: "https://github.com/acme/widgets/pull/7#pullrequestreview-1",
        commentCount: 3,
        ts,
        revision: 1,
      });
      expect(lastReviewSubmission(s)!.event).toBe("APPROVE");
    });

    it("appends further rounds rather than replacing the first", () => {
      const s = fold([
        ...events,
        { ts, type: "review-submitted", event: "REQUEST_CHANGES", commentCount: 2 },
        { ts, type: "review-submitted", event: "APPROVE", commentCount: 0 },
      ]);
      expect(s.reviewSubmissions.map((r) => r.event)).toEqual(["REQUEST_CHANGES", "APPROVE"]);
      expect(lastReviewSubmission(s)!.event).toBe("APPROVE");
    });

    it("leaves a log without any submission with an empty list", () => {
      expect(fold(events).reviewSubmissions).toEqual([]);
      expect(lastReviewSubmission(fold(events))).toBeUndefined();
    });

    it("does not disturb the rest of the fold", () => {
      const before = fold(events);
      const after = fold([...events, { ts, type: "review-submitted", event: "COMMENT" }]);
      expect({ ...after, reviewSubmissions: [] }).toEqual(before);
    });
  });

  describe("readiness", () => {
    it("counts must-read units still unread", () => {
      const r = readiness(fold(events));
      expect(r.mustRead).toEqual({ complete: 0, total: 1, unviewed: 1 });
      expect(r.ready).toBe(false);
    });

    it("is ready once every must-read unit is viewed", () => {
      const r = readiness(
        fold([
          ...events,
          { ts, type: "unit-viewed", unitId: "core", revision: 1 },
        ]),
      );
      expect(r.mustRead).toEqual({ complete: 1, total: 1, unviewed: 0 });
      expect(r.hunks).toEqual({ viewed: 2, total: 3 });
      expect(r.ready).toBe(true);
    });
  });
});

describe("analysis run events", () => {
  it("records a run as running, then terminal", () => {
    const running = fold([...events, { ts, type: "analysis-started", revision: 1 }]);
    expect(running.analysisRun).toEqual({ revision: 1, status: "running", startedAt: ts });

    const finished = fold([
      ...events,
      { ts, type: "analysis-started", revision: 1 },
      { ts, type: "analysis-finished", revision: 1, status: "failed", error: "boom" },
    ]);
    expect(finished.analysisRun).toMatchObject({
      revision: 1,
      status: "failed",
      error: "boom",
      finishedAt: ts,
    });
  });

  it("is absent on logs that predate the events, and disturbs nothing else", () => {
    const before = fold(events);
    expect(before.analysisRun).toBeUndefined();
    const after = fold([...events, { ts, type: "analysis-started", revision: 1 }]);
    expect({ ...after, analysisRun: undefined }).toEqual({ ...before, analysisRun: undefined });
  });
});

describe("husks: units whose every hunk left the PR", () => {
  /**
   * A revision-added event with a migration report. `carry` maps old->new
   * ids that survive (identical); `archive` lists old ids that left; `added`
   * lists brand-new ids.
   */
  function revision(
    n: number,
    opts: { carry?: Record<string, string>; archive?: string[]; added?: string[] },
  ): ReviewerEvent {
    const entries: MigrationEntry[] = [
      ...Object.entries(opts.carry ?? {}).map(([prev, next]) => ({
        status: "identical" as const,
        hunkId: next,
        previousHunkId: prev,
        file: "a.ts",
      })),
      ...(opts.archive ?? []).map((id) => ({ status: "archived" as const, hunkId: id, file: "a.ts" })),
      ...(opts.added ?? []).map((id) => ({ status: "new" as const, hunkId: id, file: "a.ts" })),
    ];
    const live = [...Object.values(opts.carry ?? {}), ...(opts.added ?? [])];
    return {
      ts,
      type: "revision-added",
      revision: n,
      baseSha: `base${n}`,
      headSha: `head${n}`,
      mergeBase: `mb${n}`,
      baseOnly: false,
      files: [{ path: "a.ts", hunkIds: live }],
      migration: {
        revision: n,
        previousRevision: n - 1,
        baseOnly: false,
        counts: { identical: 0, fuzzy: 0, renamed: 0, archived: 0, new: 0 },
        entries,
      },
    };
  }

  // r2 drops every hunk of "core" (h1, h2) and keeps "wire" (h3).
  const dropCore = revision(2, { carry: { h3: "h3" }, archive: ["h1", "h2"] });

  it("turns a fully emptied unit into a husk, keeping what it said", () => {
    const s = fold([...events, dropCore]);
    const core = s.units.find((u) => u.id === "core")!;
    expect(core).toMatchObject({
      hunkIds: [],
      removedAtRevision: 2,
      readBeforeRemoval: false,
      title: "Widget core",
      summary: "The logic.",
      kind: "core-logic",
      attention: "must-read",
    });
    expect(removedUnits(s).map((u) => u.id)).toEqual(["core"]);
    expect(liveUnits(s).map((u) => u.id)).toEqual(["wire"]);
  });

  it("records readBeforeRemoval only when every previous hunk was viewed", () => {
    const partly = fold([
      ...events,
      { ts, type: "hunk-viewed", hunkId: "h1", revision: 1 },
      dropCore,
    ]);
    expect(partly.units.find((u) => u.id === "core")!.readBeforeRemoval).toBe(false);

    const fully = fold([...events, { ts, type: "unit-viewed", unitId: "core", revision: 1 }, dropCore]);
    expect(fully.units.find((u) => u.id === "core")!.readBeforeRemoval).toBe(true);
  });

  it("deletes the husk on the next revision", () => {
    const s = fold([...events, dropCore, revision(3, { carry: { h3: "h3" } })]);
    expect(s.units.map((u) => u.id)).toEqual(["wire"]);
  });

  it("keeps the husk when the same revision is replayed", () => {
    const s = fold([...events, dropCore, dropCore]);
    expect(removedUnits(s).map((u) => u.id)).toEqual(["core"]);
  });

  it("revives a husk given hunks again via set-unit (unit-updated)", () => {
    const s = fold([
      ...events,
      dropCore,
      { ts, type: "unit-updated", unitId: "core", patch: { hunkIds: ["h3"] } },
      { ts, type: "unit-updated", unitId: "wire", patch: { hunkIds: [] } },
    ]);
    const core = s.units.find((u) => u.id === "core")!;
    expect(core.hunkIds).toEqual(["h3"]);
    expect(core.removedAtRevision).toBeUndefined();
    expect(core.readBeforeRemoval).toBeUndefined();
    // and a revived unit survives the next revision like any other
    const later = fold([
      ...events,
      dropCore,
      { ts, type: "unit-updated", unitId: "core", patch: { hunkIds: ["h3"] } },
      revision(3, { carry: { h3: "h3" } }),
    ]);
    expect(later.units.find((u) => u.id === "core")?.hunkIds).toEqual(["h3"]);
  });

  it("drops husks on analysis-set unless re-sent, and revives a re-sent one with hunks", () => {
    const withHusk = fold([...events, dropCore]);
    const wire = withHusk.units.find((u) => u.id === "wire")!;
    const core = withHusk.units.find((u) => u.id === "core")!;
    const replaced = fold([
      ...events,
      dropCore,
      { ts, type: "analysis-set", revision: 2, summary: "", unassigned: [], units: [wire] },
    ]);
    expect(replaced.units.map((u) => u.id)).toEqual(["wire"]);

    const resent = fold([
      ...events,
      dropCore,
      {
        ts,
        type: "analysis-set",
        revision: 2,
        summary: "",
        unassigned: [],
        units: [{ ...core, hunkIds: ["h3"] }, { ...wire, hunkIds: [] }],
      },
    ]);
    expect(resent.units.find((u) => u.id === "core")!.removedAtRevision).toBeUndefined();
  });

  it("leaves husks out of progress, completion and readiness", () => {
    const s = fold([...events, dropCore]);
    expect(unitProgress(s).map((p) => p.unitId)).toEqual(["wire"]);
    const r = readiness(s);
    expect(r.units.total).toBe(1);
    // the only must-read unit is a husk: nothing must-read is left to read
    expect(r.mustRead.total).toBe(0);
    expect(r.ready).toBe(true);
  });

  it("keeps a partially emptied unit a normal unit", () => {
    const s = fold([...events, revision(2, { carry: { h1: "h1", h3: "h3" }, archive: ["h2"] })]);
    const core = s.units.find((u) => u.id === "core")!;
    expect(core.hunkIds).toEqual(["h1"]);
    expect(core.removedAtRevision).toBeUndefined();
    expect(core.readBeforeRemoval).toBeUndefined();
    expect(removedUnits(s)).toEqual([]);
  });

  it("does not make a husk of a unit that never had hunks", () => {
    const s = fold([
      ...events,
      { ts, type: "unit-updated", unitId: "wire", patch: { hunkIds: [] } },
      revision(2, { carry: { h1: "h1", h2: "h2" }, archive: ["h3"] }),
    ]);
    expect(s.units.find((u) => u.id === "wire")!.removedAtRevision).toBeUndefined();
  });
});
