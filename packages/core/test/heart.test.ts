import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fold, pruneHeart } from "../src/reducer.js";
import { setAnalysis, setUnit, setUnits } from "../src/service.js";
import { appendEvent, writeMeta, writeRevision } from "../src/store.js";
import { computeHunkId } from "../src/hunk-id.js";
import { toRevisionFiles } from "../src/migration.js";
import type { FileDiff, PrKey } from "../src/index.js";
import { ReviewUnitSchema, type ReviewerEvent, type ReviewUnit } from "../src/schemas.js";

/**
 * The heart of a unit: one to three of its own hunks, each with a why. It
 * follows its hunks through patches and migrations and never points outside
 * the unit.
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
    hunkIds: ["h1", "h2"],
    order: 1,
    ...over,
  });
}

describe("heart schema", () => {
  it("is optional, capped at three, and each entry needs a hunk and a why", () => {
    expect(unit().heart).toBeUndefined();
    expect(unit({ heart: [{ hunkId: "h1", why: "the rule itself" }] }).heart).toHaveLength(1);
    expect(() =>
      unit({ heart: [1, 2, 3, 4].map((n) => ({ hunkId: `h${n}`, why: "w" })) }),
    ).toThrow();
    expect(() => unit({ heart: [{ hunkId: "h1", why: "" }] as never })).toThrow();
  });

  it("takes an optional [from, to] line range of positive ints with from <= to", () => {
    expect(unit({ heart: [{ hunkId: "h1", why: "w", lines: [12, 30] }] }).heart?.[0].lines).toEqual([12, 30]);
    expect(unit({ heart: [{ hunkId: "h1", why: "w", lines: [7, 7] }] }).heart?.[0].lines).toEqual([7, 7]);
    for (const lines of [[30, 12], [0, 3], [1.5, 3], [1], [1, 2, 3], "1-3", [-1, 2]]) {
      expect(() => unit({ heart: [{ hunkId: "h1", why: "w", lines }] as never }), JSON.stringify(lines)).toThrow();
    }
  });
});

describe("pruneHeart", () => {
  it("drops entries that point outside the unit, dedupes, and removes the key when empty", () => {
    const u = unit({
      heart: [
        { hunkId: "h1", why: "a" },
        { hunkId: "h9", why: "gone" },
        { hunkId: "h1", why: "twice" },
      ],
    });
    expect(pruneHeart(u).heart).toEqual([{ hunkId: "h1", why: "a" }]);
    expect(pruneHeart(unit({ heart: [{ hunkId: "h9", why: "gone" }] })).heart).toBeUndefined();
    const same = unit({ heart: [{ hunkId: "h2", why: "b" }] });
    expect(pruneHeart(same)).toBe(same);
  });
});

describe("heart through the reducer", () => {
  const rev = (revision: number, hunkIds = ["h1", "h2"]) =>
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

  const analysis = (): ReviewerEvent => ({
    ts,
    type: "analysis-set",
    revision: 1,
    summary: "s",
    units: [
      unit({
        heart: [
          { hunkId: "h1", why: "the rule" },
          { hunkId: "h2", why: "its guard" },
        ],
      }),
    ],
    unassigned: [],
  });

  it("folds through analysis-set", () => {
    const state = fold([rev(1), analysis()]);
    expect(state.units[0].heart).toHaveLength(2);
  });

  it("loses the entry of a hunk a patch takes out of the unit", () => {
    const state = fold([
      rev(1),
      analysis(),
      { ts, type: "unit-updated", unitId: "u1", patch: { hunkIds: ["h1"] } },
    ]);
    expect(state.units[0].heart).toEqual([{ hunkId: "h1", why: "the rule" }]);
  });

  it("follows a reworked hunk to its successor and drops an archived one", () => {
    const migration = {
      revision: 2,
      previousRevision: 1,
      baseOnly: false,
      counts: { identical: 0, fuzzy: 1, renamed: 0, archived: 1, new: 0 },
      entries: [
        { status: "fuzzy", hunkId: "h1b", previousHunkId: "h1", file: "a.ts", score: 0.8 },
        { status: "archived", hunkId: "h2", file: "a.ts", wasViewed: false },
      ],
    };
    const state = fold([
      rev(1),
      analysis(),
      { ...(rev(2, ["h1b"]) as Record<string, unknown>), migration } as unknown as ReviewerEvent,
    ]);
    expect(state.units[0].hunkIds).toEqual(["h1b"]);
    expect(state.units[0].heart).toEqual([{ hunkId: "h1b", why: "the rule" }]);
  });

  it("keeps a heart's line range through an identical match and drops it when the hunk was reworked", () => {
    const withLines: ReviewerEvent = {
      ts,
      type: "analysis-set",
      revision: 1,
      summary: "s",
      units: [
        unit({
          heart: [
            { hunkId: "h1", why: "the rule", lines: [3, 9] },
            { hunkId: "h2", why: "its guard", lines: [1, 2] },
          ],
        }),
      ],
      unassigned: [],
    };
    const migration = {
      revision: 2,
      previousRevision: 1,
      baseOnly: false,
      counts: { identical: 1, fuzzy: 1, renamed: 0, archived: 0, new: 0 },
      entries: [
        { status: "fuzzy", hunkId: "h1b", previousHunkId: "h1", file: "a.ts", score: 0.8 },
        { status: "identical", hunkId: "h2", previousHunkId: "h2", file: "a.ts" },
      ],
    };
    const state = fold([
      rev(1),
      withLines,
      { ...(rev(2, ["h1b", "h2"]) as Record<string, unknown>), migration } as unknown as ReviewerEvent,
    ]);
    expect(state.units[0].heart).toEqual([
      { hunkId: "h1b", why: "the rule" },
      { hunkId: "h2", why: "its guard", lines: [1, 2] },
    ]);
  });

  it("has no heart key once every heart hunk left the PR", () => {
    const migration = {
      revision: 2,
      previousRevision: 1,
      baseOnly: false,
      counts: { identical: 0, fuzzy: 0, renamed: 0, archived: 2, new: 1 },
      entries: [
        { status: "archived", hunkId: "h1", file: "a.ts", wasViewed: false },
        { status: "archived", hunkId: "h2", file: "a.ts", wasViewed: false },
        { status: "new", hunkId: "h3", file: "a.ts" },
      ],
    };
    const state = fold([
      rev(1),
      analysis(),
      { ...(rev(2, ["h3"]) as Record<string, unknown>), migration } as unknown as ReviewerEvent,
    ]);
    expect(state.units[0].heart).toBeUndefined();
  });
});

describe("heart through the CLI-facing service", () => {
  const key: PrKey = { host: "github.com", owner: "acme", repo: "widgets", number: 43 };
  let tmp: string;
  let a1: string;
  let a2: string;
  let b1: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-heart-"));
    writeMeta(
      key,
      {
        host: key.host,
        owner: key.owner,
        repo: key.repo,
        number: key.number,
        url: "https://github.com/acme/widgets/pull/43",
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

  const payload = (heart?: unknown) => ({
    summary: "s",
    units: [
      { ...unit({ id: "alpha", hunkIds: [a1, a2] }), heart },
      unit({ id: "beta", hunkIds: [b1], order: 2 }),
    ],
    unassigned: [],
  });

  it("set-analysis accepts a heart of the unit's own hunks, resolving short ids", () => {
    const { state } = setAnalysis(key, payload([{ hunkId: a2.slice(0, 8), why: "the rule" }]), {}, tmp);
    expect(state.units[0].heart).toEqual([{ hunkId: a2, why: "the rule" }]);
  });

  it("set-analysis rejects a heart hunk that belongs to another unit, naming it", () => {
    expect(() => setAnalysis(key, payload([{ hunkId: b1, why: "wrong unit" }]), {}, tmp)).toThrow(/alpha: /);
  });

  it("set-unit patches a heart with short ids judged on the list after the patch", () => {
    setAnalysis(key, payload(undefined), {}, tmp);
    const { state } = setUnits(
      key,
      [
        { unitId: "beta", payload: { removeHunkIds: [b1] } },
        { unitId: "alpha", payload: { addHunkIds: [b1], heart: [{ hunkId: b1.slice(0, 8), why: "moved in" }] } },
      ],
      tmp,
    );
    expect(state.units[0].heart).toEqual([{ hunkId: b1, why: "moved in" }]);
  });

  it("set-analysis and set-unit carry a heart's line range and refuse a backwards one", () => {
    const { state } = setAnalysis(key, payload([{ hunkId: a1, why: "the rule", lines: [4, 20] }]), {}, tmp);
    expect(state.units[0].heart).toEqual([{ hunkId: a1, why: "the rule", lines: [4, 20] }]);
    expect(() => setAnalysis(key, payload([{ hunkId: a1, why: "the rule", lines: [20, 4] }]), {}, tmp)).toThrow();
    expect(() => setUnit(key, "alpha", { heart: [{ hunkId: a1, why: "x", lines: [20, 4] }] }, {}, tmp)).toThrow(
      /lines/,
    );
    const patched = setUnit(key, "alpha", { heart: [{ hunkId: a2, why: "x", lines: [1, 1] }] }, {}, tmp);
    expect(patched.units[0].heart).toEqual([{ hunkId: a2, why: "x", lines: [1, 1] }]);
  });

  it("set-unit refuses a heart hunk the unit does not hold", () => {
    setAnalysis(key, payload(undefined), {}, tmp);
    expect(() => setUnit(key, "alpha", { heart: [{ hunkId: b1, why: "x" }] }, {}, tmp)).toThrow(
      /not a hunk this unit holds/,
    );
  });
});
