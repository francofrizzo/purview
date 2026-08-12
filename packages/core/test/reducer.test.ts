import { describe, expect, it } from "vitest";
import {
  fold,
  lastReviewSubmission,
  readiness,
  unitProgress,
  viewedFiles,
} from "../src/reducer.js";
import type { ReviewerEvent } from "../src/schemas.js";

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
