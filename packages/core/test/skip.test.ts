import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fold, skippedHunkIds, readiness, unitProgress } from "../src/reducer.js";
import { heartOf, hunkIdsOf, labelOf, normalizeHunks, skipOf } from "../src/units.js";
import { setAnalysis, setUnit, setUnits } from "../src/service.js";
import { appendEvent, writeMeta, writeRevision } from "../src/store.js";
import { computeHunkId } from "../src/hunk-id.js";
import { toRevisionFiles } from "../src/migration.js";
import { renderUnits } from "../src/unit-patch.js";
import type { FileDiff, PrKey } from "../src/index.js";
import { ReviewUnitSchema, type ReviewUnitInput, type ReviewerEvent, type ReviewUnit } from "../src/schemas.js";

/**
 * Skippable hunks: entries of a unit's `hunks` with `skip: true`. A skip
 * needs a label (the reason), counts toward no progress total, and survives
 * only a migration whose hunk came through byte-for-byte. A plain `label`
 * follows the same rule.
 */

const ts = "2026-01-01T00:00:00.000Z";

function unit(over: Partial<ReviewUnitInput> = {}): ReviewUnit {
  return ReviewUnitSchema.parse({
    id: "u1",
    title: "Unit",
    summary: "Summary",
    kind: "core-logic",
    attention: "must-read",
    attentionWhy: "why",
    riskFlags: [],
    hunks: ["h1", "h2", "h3"],
    order: 1,
    ...over,
  });
}

describe("hunk entry schema", () => {
  it("normalizes bare ids to entries and keeps entries as sent", () => {
    expect(unit().hunks).toEqual([{ id: "h1" }, { id: "h2" }, { id: "h3" }]);
    const u = unit({ hunks: ["h1", { id: "h2", skip: true, label: "adds imports" }, { id: "h3", label: "the test" }] });
    expect(skipOf(u)).toEqual([{ id: "h2", skip: true, label: "adds imports" }]);
    expect(heartOf(u)).toEqual([]);
    expect(labelOf(u, "h3")).toBe("the test");
    expect(labelOf(u, "h2")).toBe("adds imports");
    expect(labelOf(u, "h1")).toBeUndefined();
  });

  it("a skip needs a label, a label is at most 120 chars, and skip is only ever true", () => {
    expect(() => unit({ hunks: [{ id: "h2", skip: true }] })).toThrow(/skip needs a label/);
    expect(() => unit({ hunks: [{ id: "h2", skip: true, label: "" }] })).toThrow();
    expect(() => unit({ hunks: [{ id: "h2", label: "x".repeat(121) }] })).toThrow();
    expect(() => unit({ hunks: [{ id: "h2", skip: false, label: "x" }] as never })).toThrow();
  });

  it("refuses duplicate ids and a hunk that is both skip and heart", () => {
    expect(() => unit({ hunks: ["h1", "h1"] })).toThrow(/listed twice/);
    expect(() => unit({ hunks: [{ id: "h1", skip: true, label: "x", heart: [{ why: "w" }] }] })).toThrow(
      /not both skip and heart/,
    );
  });
});

describe("normalizeHunks", () => {
  it("dedupes by id, first wins, and returns the same object when nothing changes", () => {
    const raw = { ...unit(), hunks: [{ id: "h2", skip: true as const, label: "a" }, { id: "h9" }, { id: "h2", label: "twice" }] };
    expect(normalizeHunks(raw).hunks).toEqual([{ id: "h2", skip: true, label: "a" }, { id: "h9" }]);
    const same = unit({ hunks: [{ id: "h2", skip: true, label: "b" }] });
    expect(normalizeHunks(same)).toBe(same);
  });
});

describe("skip through the reducer", () => {
  const rev = (revision: number, hunkIds = ["h1", "h2", "h3"]) =>
    ({
      ts,
      type: "revision-added",
      revision,
      baseSha: `b${revision}`,
      headSha: `h${revision}`,
      mergeBase: `m${revision}`,
      baseOnly: false,
      files: [{ path: "a.ts", hunkIds }],
    }) as ReviewerEvent;

  const analysis = (over: Partial<ReviewUnitInput> = {}): ReviewerEvent => ({
    ts,
    type: "analysis-set",
    revision: 1,
    summary: "s",
    units: [
      unit({
        hunks: [
          { id: "h1", heart: [{ why: "the rule" }] },
          { id: "h2", skip: true, label: "adds imports" },
          { id: "h3", skip: true, label: "re-export only" },
        ],
        ...over,
      }),
    ],
    unassigned: [],
  });

  const view = (hunkId: string): ReviewerEvent => ({ ts, type: "hunk-viewed", hunkId, revision: 1 });

  it("folds through analysis-set and lists the skipped ids", () => {
    const state = fold([rev(1), analysis()]);
    expect(skipOf(state.units[0])).toHaveLength(2);
    expect([...skippedHunkIds(state)].sort()).toEqual(["h2", "h3"]);
  });

  it("loses the entry of a hunk a patch takes out of the unit", () => {
    const state = fold([
      rev(1),
      analysis(),
      { ts, type: "unit-updated", unitId: "u1", patch: { removeHunkIds: ["h3"] } },
    ]);
    expect(state.units[0].hunks).toEqual([
      { id: "h1", heart: [{ why: "the rule" }] },
      { id: "h2", skip: true, label: "adds imports" },
    ]);
  });

  it("ignores skips of husks", () => {
    const migration = {
      revision: 2,
      previousRevision: 1,
      baseOnly: false,
      counts: { identical: 0, fuzzy: 0, renamed: 0, archived: 3, new: 1 },
      entries: [
        { status: "archived", hunkId: "h1", file: "a.ts", wasViewed: false },
        { status: "archived", hunkId: "h2", file: "a.ts", wasViewed: false },
        { status: "archived", hunkId: "h3", file: "a.ts", wasViewed: false },
        { status: "new", hunkId: "h4", file: "a.ts" },
      ],
    };
    const state = fold([
      rev(1),
      analysis(),
      { ...(rev(2, ["h4"]) as Record<string, unknown>), migration } as unknown as ReviewerEvent,
    ]);
    expect(state.units[0].hunks).toEqual([]);
    expect(skippedHunkIds(state).size).toBe(0);
  });

  it("keeps the skip of an identical hunk and drops the skip and label of a reworked one", () => {
    const migration = {
      revision: 2,
      previousRevision: 1,
      baseOnly: false,
      counts: { identical: 2, fuzzy: 1, renamed: 0, archived: 0, new: 0 },
      entries: [
        { status: "identical", hunkId: "h1", previousHunkId: "h1", file: "a.ts" },
        { status: "identical", hunkId: "h2", previousHunkId: "h2", file: "a.ts" },
        { status: "fuzzy", hunkId: "h3b", previousHunkId: "h3", file: "a.ts", score: 0.8 },
      ],
    };
    const state = fold([
      rev(1),
      analysis(),
      { ...(rev(2, ["h1", "h2", "h3b"]) as Record<string, unknown>), migration } as unknown as ReviewerEvent,
    ]);
    expect(state.units[0].hunks).toEqual([
      { id: "h1", heart: [{ why: "the rule" }] },
      { id: "h2", skip: true, label: "adds imports" },
      { id: "h3b" },
    ]);
  });

  it("drops the skip of a renamed hunk, following the heart to its successor", () => {
    const migration = {
      revision: 2,
      previousRevision: 1,
      baseOnly: false,
      counts: { identical: 0, fuzzy: 0, renamed: 3, archived: 0, new: 0 },
      entries: [
        { status: "renamed", hunkId: "h1b", previousHunkId: "h1", file: "b.ts" },
        { status: "renamed", hunkId: "h2b", previousHunkId: "h2", file: "b.ts" },
        { status: "renamed", hunkId: "h3b", previousHunkId: "h3", file: "b.ts" },
      ],
    };
    const state = fold([
      rev(1),
      analysis(),
      { ...(rev(2, ["h1b", "h2b", "h3b"]) as Record<string, unknown>), migration } as unknown as ReviewerEvent,
    ]);
    expect(heartOf(state.units[0])).toEqual([{ id: "h1b", segments: [{ why: "the rule" }] }]);
    expect(skipOf(state.units[0])).toEqual([]);
    expect(hunkIdsOf(state.units[0])).toEqual(["h1b", "h2b", "h3b"]);
  });

  it("a plain label likewise survives only an identical match", () => {
    const migration = {
      revision: 2,
      previousRevision: 1,
      baseOnly: false,
      counts: { identical: 1, fuzzy: 1, renamed: 0, archived: 0, new: 0 },
      entries: [
        { status: "identical", hunkId: "h1", previousHunkId: "h1", file: "a.ts" },
        { status: "fuzzy", hunkId: "h2b", previousHunkId: "h2", file: "a.ts", score: 0.8 },
      ],
    };
    const state = fold([
      rev(1, ["h1", "h2"]),
      analysis({ hunks: [{ id: "h1", label: "the test" }, { id: "h2", label: "the fixture" }] }),
      { ...(rev(2, ["h1", "h2b"]) as Record<string, unknown>), migration } as unknown as ReviewerEvent,
    ]);
    expect(state.units[0].hunks).toEqual([{ id: "h1", label: "the test" }, { id: "h2b" }]);
  });

  it("leaves skipped hunks out of unit progress", () => {
    const [p] = unitProgress(fold([rev(1), analysis()]));
    expect(p.total).toBe(1);
    expect(p.viewed).toBe(0);
    expect(p.complete).toBe(false);
    const [done] = unitProgress(fold([rev(1), analysis(), view("h1")]));
    expect(done).toMatchObject({ viewed: 1, total: 1, complete: true });
  });

  it("a unit whose hunks are all skipped is never complete", () => {
    const all = analysis({
      hunks: [
        { id: "h1", skip: true, label: "a" },
        { id: "h2", skip: true, label: "b" },
        { id: "h3", skip: true, label: "c" },
      ],
    });
    const [p] = unitProgress(fold([rev(1), all, view("h1"), view("h2"), view("h3")]));
    expect(p).toMatchObject({ viewed: 0, total: 0, complete: false });
  });

  it("leaves skipped hunks out of readiness, even when they were viewed", () => {
    const state = fold([rev(1), analysis(), view("h2")]);
    const r = readiness(state);
    expect(r.hunks).toEqual({ viewed: 0, total: 1 });
    expect(r.ready).toBe(false);
    const after = readiness(fold([rev(1), analysis(), view("h2"), view("h1")]));
    expect(after.hunks).toEqual({ viewed: 1, total: 1 });
    expect(after.ready).toBe(true);
  });

  it("leaves skipped hunks out of the file rollups, and a file of only skips has nothing to view", () => {
    const state = fold([rev(1), analysis(), view("h1")]);
    expect(state.files[0]).toMatchObject({ total: 1, viewedCount: 1, viewed: true });
    expect(state.hunks.h2.viewed).toBe(false);
    const split = fold([
      {
        ...(rev(1) as Record<string, unknown>),
        files: [
          { path: "a.ts", hunkIds: ["h1"] },
          { path: "b.ts", hunkIds: ["h2", "h3"] },
        ],
      } as unknown as ReviewerEvent,
      analysis(),
      view("h2"),
      view("h3"),
    ]);
    expect(split.files[1]).toMatchObject({ total: 0, viewedCount: 0, viewed: false });
    // The reader's own mark on a skipped hunk is kept.
    expect(split.hunks.h2.viewed).toBe(true);
  });

  it("the units listing counts hearts, skips and labels and prints the ids", () => {
    const state = fold([rev(1), analysis()]);
    const { text } = renderUnits(state);
    expect(text).toContain("(3 hunks, 1 heart, 2 skippable, heart: h1, skip: h2 h3)");
    const labelled = fold([rev(1), analysis({ hunks: ["h1", { id: "h2", label: "the test" }, "h3"] })]);
    expect(renderUnits(labelled).text).toContain("(3 hunks, 1 labelled)");
    const ranged = fold([rev(1), analysis({ hunks: [{ id: "h1", heart: [{ why: "a", lines: [3, 9] }, { why: "b", lines: [20, 30] }] }, "h2", "h3"] })]);
    expect(renderUnits(ranged).text).toContain("heart: h1:3-9,20-30)");
  });
});

describe("skip through the CLI-facing service", () => {
  const key: PrKey = { host: "github.com", owner: "acme", repo: "widgets", number: 44 };
  let tmp: string;
  let a1: string;
  let a2: string;
  let b1: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-fold-"));
    writeMeta(
      key,
      {
        host: key.host,
        owner: key.owner,
        repo: key.repo,
        number: key.number,
        url: "https://github.com/acme/widgets/pull/44",
        createdAt: ts,
        archived: false,
      },
      tmp,
    );
    const mk = (file: string, added: string[]) => ({
      id: computeHunkId(file, added, []),
      file,
      oldStart: 1,
      oldLines: 0,
      newStart: 1,
      newLines: added.length,
      header: "",
      addedLines: added,
      removedLines: [],
      text: "",
    });
    const ha1 = mk("src/a.ts", ["a1()"]);
    const ha2 = mk("src/a.ts", ["a2()"]);
    const hb1 = mk("src/b.ts", ["b1()"]);
    a1 = ha1.id;
    a2 = ha2.id;
    b1 = hb1.id;
    const files: FileDiff[] = [
      { path: "src/a.ts", status: "modified", binary: false, hunks: [ha1, ha2] },
      { path: "src/b.ts", status: "modified", binary: false, hunks: [hb1] },
    ];
    writeRevision(key, 1, "diff", files, { baseSha: "b", headSha: "h", mergeBase: "m" }, tmp);
    appendEvent(
      key,
      {
        type: "revision-added",
        revision: 1,
        baseSha: "b",
        headSha: "h",
        mergeBase: "m",
        baseOnly: false,
        files: toRevisionFiles(files),
      },
      tmp,
    );
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const payload = (alphaHunks?: unknown) => ({
    summary: "s",
    units: [
      { ...unit({ id: "alpha", hunks: [a1, a2] }), ...(alphaHunks ? { hunks: alphaHunks } : {}) },
      unit({ id: "beta", hunks: [b1], order: 2 }),
    ],
    unassigned: [],
  });

  it("set-analysis accepts a skip entry, resolving short ids", () => {
    const { state } = setAnalysis(key, payload([a1, { id: a2.slice(0, 8), skip: true, label: "adds imports" }]), {}, tmp);
    expect(state.units[0].hunks).toEqual([{ id: a1 }, { id: a2, skip: true, label: "adds imports" }]);
  });

  it("set-analysis rejects a hunk listed in two units, naming it", () => {
    expect(() => setAnalysis(key, payload([a1, a2, { id: b1, skip: true, label: "wrong unit" }]), {}, tmp)).toThrow(
      new RegExp(`more than one place[\\s\\S]*${b1}: alpha, beta`),
    );
  });

  it("set-analysis rejects a skip without a label, naming the unit", () => {
    expect(() => setAnalysis(key, payload([a1, { id: a2, skip: true }]), {}, tmp)).toThrow(/skip needs a label/);
  });

  it("set-unit marks a skip through addHunks with short ids, judged on the list after the patch", () => {
    setAnalysis(key, payload(), {}, tmp);
    const { state } = setUnits(
      key,
      [
        { unitId: "beta", payload: { removeHunkIds: [b1] } },
        { unitId: "alpha", payload: { addHunks: [{ id: b1.slice(0, 8), skip: true, label: "moved in" }] } },
      ],
      tmp,
    );
    expect(state.units[0].hunks).toEqual([{ id: a1 }, { id: a2 }, { id: b1, skip: true, label: "moved in" }]);
    expect(state.units[1].hunks).toEqual([]);
  });

  it("set-unit refuses a hunk another unit holds", () => {
    setAnalysis(key, payload(), {}, tmp);
    expect(() => setUnit(key, "alpha", { addHunks: [{ id: b1, skip: true, label: "x" }] }, {}, tmp)).toThrow(
      /would belong to more than one unit/,
    );
  });

  it("an upsert replaces a hunk's entry in place, and a bare id clears it", () => {
    setAnalysis(key, payload([{ id: a1, heart: [{ why: "the rule" }] }, a2]), {}, tmp);
    const skipped = setUnit(key, "alpha", { addHunks: [{ id: a1, skip: true, label: "imports" }] }, {}, tmp);
    expect(skipped.units[0].hunks).toEqual([{ id: a1, skip: true, label: "imports" }, { id: a2 }]);
    const cleared = setUnit(key, "alpha", { addHunks: [a1] }, {}, tmp);
    expect(cleared.units[0].hunks).toEqual([{ id: a1 }, { id: a2 }]);
  });
});

describe("fileOrder through the reducer", () => {
  const rev = (revision: number): ReviewerEvent =>
    ({
      ts,
      type: "revision-added",
      revision,
      baseSha: `b${revision}`,
      headSha: `h${revision}`,
      mergeBase: `m${revision}`,
      baseOnly: false,
      files: [
        { path: "a.ts", hunkIds: ["h1"] },
        { path: "b.ts", hunkIds: ["h2"] },
        { path: "c.ts", hunkIds: ["h3"] },
      ],
    }) as ReviewerEvent;
  const analysis = (fileOrder?: string[]): ReviewerEvent => ({
    ts,
    type: "analysis-set",
    revision: 1,
    summary: "s",
    units: [unit({ fileOrder })],
    unassigned: [],
  });

  it("keeps the listed paths the unit touches, in order, and drops the rest", () => {
    const state = fold([rev(1), analysis(["c.ts", "zzz.ts", "a.ts", "c.ts"])]);
    expect(state.units[0].fileOrder).toEqual(["c.ts", "a.ts"]);
  });

  it("removes the key when no listed path is touched, and stays absent when never sent", () => {
    expect(fold([rev(1), analysis(["zzz.ts"])]).units[0].fileOrder).toBeUndefined();
    expect(fold([rev(1), analysis()]).units[0].fileOrder).toBeUndefined();
  });

  it("follows a unit patch that drops a file", () => {
    const state = fold([
      rev(1),
      analysis(["c.ts", "a.ts"]),
      { ts, type: "unit-updated", unitId: "u1", patch: { hunks: ["h1", "h2"] } } as ReviewerEvent,
    ]);
    expect(state.units[0].fileOrder).toEqual(["a.ts"]);
  });
});
