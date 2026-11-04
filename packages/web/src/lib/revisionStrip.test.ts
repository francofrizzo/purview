import { describe, expect, it } from "vitest";
import type { PrState, ReviewUnit } from "../api/types";
import { revisionStrip, stripStatus } from "./revisionStrip";

const unit = (id: string, over: Partial<ReviewUnit> = {}): ReviewUnit => ({
  id,
  title: `Unit ${id}`,
  summary: "",
  kind: "core-logic",
  attention: "must-read",
  attentionWhy: "",
  riskFlags: [],
  hunks: [],
  order: 1,
  ...over,
});

const state = (over: Partial<PrState> = {}): PrState => ({
  revision: 3,
  revisions: [
    { revision: 1, addedAt: "2026-05-11T09:12:00.000Z" },
    { revision: 2, addedAt: "2026-05-12T15:40:00.000Z", summary: "Revision 2: jitter on the retry" },
    { revision: 3, addedAt: "2026-05-13T10:05:00.000Z", summary: "keys drop the timestamp" },
  ],
  units: [],
  hunks: {},
  ...over,
});

describe("revisionStrip", () => {
  it("is null with a single revision", () => {
    expect(revisionStrip(state({ revision: 1, revisions: [{ revision: 1 }] }), [], new Map())).toBeNull();
  });

  it("lays out one column per revision, summary label stripped, current and reviewed marked", () => {
    const m = revisionStrip(state(), [], new Map(), { reviewedAt: 2 })!;
    expect(m.columns).toEqual([
      { revision: 1, addedAt: "2026-05-11T09:12:00.000Z", summary: undefined, baseOnly: false, current: false, reviewed: false },
      { revision: 2, addedAt: "2026-05-12T15:40:00.000Z", summary: "jitter on the retry", baseOnly: false, current: false, reviewed: true },
      { revision: 3, addedAt: "2026-05-13T10:05:00.000Z", summary: "keys drop the timestamp", baseOnly: false, current: true, reviewed: false },
    ]);
  });

  it("falls back to 1..current when the state lists no revisions", () => {
    const m = revisionStrip(state({ revisions: undefined, currentRevision: 2, revision: 2 }), [], new Map())!;
    expect(m.columns.map((c) => c.revision)).toEqual([1, 2]);
  });

  it("marks changelog revisions, unread after the revision the unit was last read at", () => {
    const u = unit("charge", {
      hunks: [{ id: "h1" }, { id: "h2" }, { id: "h3", skip: true }],
      changelog: [
        { revision: 3, text: "r3: key drops the timestamp" },
        { revision: 2, text: "ledger write moved first" },
      ],
    });
    const m = revisionStrip(
      state({
        hunks: {
          h1: { viewed: true, viewedAtRevision: 2, changedSinceViewed: true },
          h2: { viewed: false, changedSinceViewed: false },
          h3: { viewed: true, viewedAtRevision: 3, changedSinceViewed: false },
        },
      }),
      [u],
      new Map([["charge", 1]]),
    )!;
    const row = m.rows[0];
    expect(row).toMatchObject({ number: 1, from: 1, to: 3, readAt: 2, changed: 1, viewed: 1, total: 2, stale: true });
    expect(row.marks).toEqual([
      { revision: 2, kind: "changed", text: "ledger write moved first", unread: false },
      { revision: 3, kind: "changed", text: "key drops the timestamp", unread: true },
    ]);
    expect(m.stale).toBe(1);
    expect(stripStatus(row)).toMatchObject({ label: "since r2", stale: true });
  });

  it("starts a unit whose every hunk is new at the revision in force", () => {
    const u = unit("recon", { hunks: [{ id: "n1" }, { id: "n2" }] });
    const row = revisionStrip(
      state({
        hunks: {
          n1: { viewed: false, changedSinceViewed: false, migration: "new" },
          n2: { viewed: false, changedSinceViewed: false, migration: "new" },
        },
      }),
      [u],
      new Map(),
    )!.rows[0];
    expect(row).toMatchObject({ from: 3, to: 3, stale: false, readAt: undefined });
    expect(row.marks).toEqual([{ revision: 3, kind: "added", unread: false }]);
    expect(stripStatus(row)).toBeNull();
  });

  it("does not call a unit new when one of its hunks carried over", () => {
    const u = unit("retry", { hunks: [{ id: "a" }, { id: "b" }] });
    const row = revisionStrip(
      state({
        hunks: {
          a: { viewed: true, viewedAtRevision: 3, changedSinceViewed: false, migration: "identical" },
          b: { viewed: false, changedSinceViewed: false, migration: "new" },
        },
      }),
      [u],
      new Map(),
    )!.rows[0];
    expect(row).toMatchObject({ from: 1, marks: [], readAt: 3, stale: false });
    expect(stripStatus(row)).toMatchObject({ label: "read r3", stale: false });
  });

  it("flags a unit read before a changelog revision even with no viewed hunk changed", () => {
    const u = unit("wiring", { hunks: [{ id: "w1" }, { id: "w2" }], changelog: [{ revision: 2, text: "route threads requestId" }] });
    const row = revisionStrip(
      state({
        hunks: {
          w1: { viewed: true, viewedAtRevision: 1, changedSinceViewed: false },
          w2: { viewed: false, changedSinceViewed: false },
        },
      }),
      [u],
      new Map(),
    )!.rows[0];
    expect(row).toMatchObject({ readAt: 1, changed: 0, stale: true });
    expect(stripStatus(row)?.tip).toBe("You last read it at r1; since then r2 changed it");
  });

  it("drops the generated unit and live husks, and adds removed units last with their removal", () => {
    const m = revisionStrip(
      state({
        removedUnits: [
          unit("cleanup", { removedAtRevision: 3, readBeforeRemoval: true, changelog: [{ revision: 2, text: "retention 30 days" }] }),
        ],
      }),
      [unit("live"), unit("generated", { origin: "generated" })],
      new Map([["live", 1]]),
    )!;
    expect(m.rows.map((r) => r.id)).toEqual(["live", "cleanup"]);
    expect(m.rows[1]).toMatchObject({ removed: true, from: 1, to: 3, stale: false });
    expect(m.rows[1].marks).toEqual([
      { revision: 2, kind: "changed", text: "retention 30 days", unread: false },
      { revision: 3, kind: "removed", unread: false },
    ]);
    expect(stripStatus(m.rows[1])?.label).toBe("read");
  });

  it("keeps a column per revision with many of them, base-only ones flagged", () => {
    const revisions = Array.from({ length: 12 }, (_, i) => ({ revision: i + 1, baseOnly: i === 5 }));
    const m = revisionStrip(state({ revision: 12, revisions }), [], new Map())!;
    expect(m.columns).toHaveLength(12);
    expect(m.columns.filter((c) => c.baseOnly).map((c) => c.revision)).toEqual([6]);
    expect(m.columns.at(-1)?.current).toBe(true);
  });
});
