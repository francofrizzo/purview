import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fold, skippedHunkIds, pruneHeart, readiness, unitProgress } from "../src/reducer.js";
import { setAnalysis, setUnit, setUnits } from "../src/service.js";
import { appendEvent, writeMeta, writeRevision } from "../src/store.js";
import { computeHunkId } from "../src/hunk-id.js";
import { toRevisionFiles } from "../src/migration.js";
import { renderUnits } from "../src/unit-patch.js";
import type { FileDiff, PrKey } from "../src/index.js";
import { ReviewUnitSchema, type ReviewerEvent, type ReviewUnit } from "../src/schemas.js";

/**
 * A unit's skip: hunks the analysis says a reader can skip. Each names one of
 * the unit's own hunks, never a heart hunk; skipped hunks count toward no
 * progress total, and a skip entry only survives a migration whose hunk came
 * through byte-for-byte.
 */

const ts = "2026-01-01T00:00:00.000Z";

function unit(over: Partial<ReviewUnit> = {}): ReviewUnit {
  return ReviewUnitSchema.parse({
    id: "u1",
    title: "Unit",
    summary: "Summary",
    kind: "core-logic",
    attention: "must-read",
    attentionWhy: "why",
    riskFlags: [],
    hunkIds: ["h1", "h2", "h3"],
    order: 1,
    ...over,
  });
}

describe("skip schema", () => {
  it("is optional and each entry needs a hunk and a short why", () => {
    expect(unit().skip).toBeUndefined();
    expect(unit({ skip: [{ hunkId: "h2", why: "adds imports" }] }).skip).toHaveLength(1);
    expect(() => unit({ skip: [{ hunkId: "h2", why: "" }] })).toThrow();
    expect(() => unit({ skip: [{ hunkId: "h2", why: "x".repeat(81) }] })).toThrow();
    expect(() => unit({ skip: [{ hunkId: "h2" }] as never })).toThrow();
  });
});

describe("pruneHeart on the skip list", () => {
  it("drops entries that point outside the unit, dedupes, and removes the key when empty", () => {
    const u = unit({
      skip: [
        { hunkId: "h2", why: "a" },
        { hunkId: "h9", why: "gone" },
        { hunkId: "h2", why: "twice" },
      ],
    });
    expect(pruneHeart(u).skip).toEqual([{ hunkId: "h2", why: "a" }]);
    expect(pruneHeart(unit({ skip: [{ hunkId: "h9", why: "gone" }] })).skip).toBeUndefined();
    const same = unit({ skip: [{ hunkId: "h2", why: "b" }] });
    expect(pruneHeart(same)).toBe(same);
  });

  it("prunes heart and skip together", () => {
    const u = unit({
      heart: [{ hunkId: "h9", why: "gone" }],
      skip: [{ hunkId: "h2", why: "imports" }],
    });
    const next = pruneHeart(u);
    expect(next.heart).toBeUndefined();
    expect(next.skip).toEqual([{ hunkId: "h2", why: "imports" }]);
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

  const analysis = (over: Partial<ReviewUnit> = {}): ReviewerEvent => ({
    ts,
    type: "analysis-set",
    revision: 1,
    summary: "s",
    units: [
      unit({
        heart: [{ hunkId: "h1", why: "the rule" }],
        skip: [
          { hunkId: "h2", why: "adds imports" },
          { hunkId: "h3", why: "re-export only" },
        ],
        ...over,
      }),
    ],
    unassigned: [],
  });

  const view = (hunkId: string): ReviewerEvent => ({ ts, type: "hunk-viewed", hunkId, revision: 1 });

  it("folds through analysis-set and lists the skipped ids", () => {
    const state = fold([rev(1), analysis()]);
    expect(state.units[0].skip).toHaveLength(2);
    expect([...skippedHunkIds(state)].sort()).toEqual(["h2", "h3"]);
  });

  it("loses the entry of a hunk a patch takes out of the unit", () => {
    const state = fold([
      rev(1),
      analysis(),
      { ts, type: "unit-updated", unitId: "u1", patch: { hunkIds: ["h1", "h2"] } },
    ]);
    expect(state.units[0].skip).toEqual([{ hunkId: "h2", why: "adds imports" }]);
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
    expect(state.units[0].skip).toBeUndefined();
    expect(skippedHunkIds(state).size).toBe(0);
  });

  it("keeps the skip of an identical hunk and drops the skip of a reworked one", () => {
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
    expect(state.units[0].hunkIds).toEqual(["h1", "h2", "h3b"]);
    expect(state.units[0].skip).toEqual([{ hunkId: "h2", why: "adds imports" }]);
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
    expect(state.units[0].heart).toEqual([{ hunkId: "h1b", why: "the rule" }]);
    expect(state.units[0].skip).toBeUndefined();
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
      heart: undefined,
      skip: [
        { hunkId: "h1", why: "a" },
        { hunkId: "h2", why: "b" },
        { hunkId: "h3", why: "c" },
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

  it("the units listing counts the skips and prints their ids", () => {
    const state = fold([rev(1), analysis()]);
    const { text } = renderUnits(state);
    expect(text).toContain("(3 hunks, 2 skippable, heart: h1, skip: h2 h3)");
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

  const payload = (over: { heart?: unknown; skip?: unknown } = {}) => ({
    summary: "s",
    units: [
      { ...unit({ id: "alpha", hunkIds: [a1, a2] }), ...over },
      unit({ id: "beta", hunkIds: [b1], order: 2 }),
    ],
    unassigned: [],
  });

  it("set-analysis accepts a fold of the unit's own hunks, resolving short ids", () => {
    const { state } = setAnalysis(key, payload({ skip: [{ hunkId: a2.slice(0, 8), why: "adds imports" }] }), {}, tmp);
    expect(state.units[0].skip).toEqual([{ hunkId: a2, why: "adds imports" }]);
  });

  it("set-analysis rejects a fold hunk that belongs to another unit, naming it", () => {
    expect(() => setAnalysis(key, payload({ skip: [{ hunkId: b1, why: "wrong unit" }] }), {}, tmp)).toThrow(
      /A unit's skip must name hunks of that unit[\s\S]*alpha: /,
    );
  });

  it("set-analysis rejects a hunk that is both heart and skip, naming it", () => {
    expect(() =>
      setAnalysis(
        key,
        payload({
          heart: [{ hunkId: a1, why: "the rule" }],
          skip: [{ hunkId: a1.slice(0, 8), why: "imports" }],
        }),
        {},
        tmp,
      ),
    ).toThrow(new RegExp(`both heart and skip[\\s\\S]*alpha: ${a1}`));
  });

  it("set-unit patches a fold with short ids judged on the list after the patch", () => {
    setAnalysis(key, payload(), {}, tmp);
    const { state } = setUnits(
      key,
      [
        { unitId: "beta", payload: { removeHunkIds: [b1] } },
        { unitId: "alpha", payload: { addHunkIds: [b1], skip: [{ hunkId: b1.slice(0, 8), why: "moved in" }] } },
      ],
      tmp,
    );
    expect(state.units[0].skip).toEqual([{ hunkId: b1, why: "moved in" }]);
  });

  it("set-unit refuses a fold hunk the unit does not hold", () => {
    setAnalysis(key, payload(), {}, tmp);
    expect(() => setUnit(key, "alpha", { skip: [{ hunkId: b1, why: "x" }] }, {}, tmp)).toThrow(
      /skip\[0\] .* is not a hunk this unit holds/,
    );
  });

  it("set-unit refuses a fold of the existing heart, and a heart of the existing fold", () => {
    setAnalysis(key, payload({ heart: [{ hunkId: a1, why: "the rule" }] }), {}, tmp);
    expect(() => setUnit(key, "alpha", { skip: [{ hunkId: a1, why: "x" }] }, {}, tmp)).toThrow(
      new RegExp(`both heart and skip.*${a1}`),
    );
    setUnit(key, "alpha", { skip: [{ hunkId: a2, why: "imports" }] }, {}, tmp);
    expect(() => setUnit(key, "alpha", { heart: [{ hunkId: a2, why: "x" }] }, {}, tmp)).toThrow(
      new RegExp(`both heart and skip.*${a2}`),
    );
    // Moving the hunk out of the heart in the same patch is fine.
    const state = setUnit(
      key,
      "alpha",
      { heart: [{ hunkId: a1, why: "the rule" }], skip: [{ hunkId: a2, why: "imports" }] },
      {},
      tmp,
    );
    expect(state.units[0].heart).toEqual([{ hunkId: a1, why: "the rule" }]);
    expect(state.units[0].skip).toEqual([{ hunkId: a2, why: "imports" }]);
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
      { ts, type: "unit-updated", unitId: "u1", patch: { hunkIds: ["h1", "h2"] } } as ReviewerEvent,
    ]);
    expect(state.units[0].fileOrder).toEqual(["a.ts"]);
  });
});

describe("`fold`, the field's first name", () => {
  const rev = {
    ts, type: "revision-added", revision: 1, baseSha: "b", headSha: "h", mergeBase: "m", baseOnly: false,
    files: [{ path: "a.ts", hunkIds: ["h1", "h2", "h3"] }],
  } as ReviewerEvent;
  const raw = (over: Record<string, unknown>) =>
    ({ id: "u1", title: "Unit", summary: "s", kind: "core-logic", attention: "must-read", attentionWhy: "w", riskFlags: [], hunkIds: ["h1", "h2", "h3"], order: 1, ...over }) as unknown as ReviewUnit;

  it("lands as skip through analysis-set, and the state carries no fold key", () => {
    const state = fold([rev, { ts, type: "analysis-set", revision: 1, summary: "s", units: [raw({ fold: [{ hunkId: "h2", why: "adds imports" }] })], unassigned: [] } as ReviewerEvent]);
    expect(state.units[0].skip).toEqual([{ hunkId: "h2", why: "adds imports" }]);
    expect("fold" in state.units[0]).toBe(false);
    expect([...skippedHunkIds(state)]).toEqual(["h2"]);
  });

  it("a patch sent as fold replaces the skip list", () => {
    const state = fold([
      rev,
      { ts, type: "analysis-set", revision: 1, summary: "s", units: [raw({ skip: [{ hunkId: "h2", why: "a" }] })], unassigned: [] } as ReviewerEvent,
      { ts, type: "unit-updated", unitId: "u1", patch: { fold: [{ hunkId: "h3", why: "b" }] } } as ReviewerEvent,
    ]);
    expect(state.units[0].skip).toEqual([{ hunkId: "h3", why: "b" }]);
    expect("fold" in state.units[0]).toBe(false);
  });
});
