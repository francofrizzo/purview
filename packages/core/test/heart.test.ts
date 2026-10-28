import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fold } from "../src/reducer.js";
import { heartOf, heartSegments, hunkIdsOf } from "../src/units.js";
import { setAnalysis, setUnit, setUnits } from "../src/service.js";
import { appendEvent, writeMeta, writeRevision } from "../src/store.js";
import { computeHunkId } from "../src/hunk-id.js";
import { toRevisionFiles } from "../src/migration.js";
import type { FileDiff, PrKey } from "../src/index.js";
import { ReviewUnitSchema, type ReviewUnitInput, type ReviewerEvent, type ReviewUnit } from "../src/schemas.js";

/**
 * The heart of a unit: one to three of its `hunks` entries carrying `heart`,
 * one to three segments each, every segment with a why. It follows its hunks
 * through patches and migrations; a segment's line range survives only an
 * identical match.
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
    hunks: ["h1", "h2"],
    order: 1,
    ...over,
  });
}

describe("heart schema", () => {
  it("is capped at three hunks, and each segment needs a why", () => {
    expect(heartOf(unit())).toEqual([]);
    expect(heartOf(unit({ hunks: [{ id: "h1", heart: [{ why: "the rule itself" }] }, "h2"] }))).toEqual([
      { id: "h1", segments: [{ why: "the rule itself" }] },
    ]);
    expect(() => unit({ hunks: [1, 2, 3, 4].map((n) => ({ id: `h${n}`, heart: [{ why: "w" }] })) })).toThrow(/at most 3/);
    expect(() => unit({ hunks: [{ id: "h1", heart: [{ why: "" }] }] })).toThrow();
    expect(() => unit({ hunks: [{ id: "h1", heart: [] }] })).toThrow();
    expect(() => unit({ hunks: [{ id: "h1", heart: [{}] }] as never })).toThrow();
  });

  it("takes an optional [from, to] line range of positive ints with from <= to", () => {
    const seg = (lines: unknown) => heartSegments(unit({ hunks: [{ id: "h1", heart: [{ why: "w", lines }] } as never] }))[0];
    expect(seg([12, 30])).toEqual({ id: "h1", why: "w", lines: [12, 30] });
    expect(seg([7, 7]).lines).toEqual([7, 7]);
    for (const lines of [[30, 12], [0, 3], [1.5, 3], [1], [1, 2, 3], "1-3", [-1, 2]]) {
      expect(() => seg(lines), JSON.stringify(lines)).toThrow();
    }
  });

  it("allows several ranged segments on one hunk, flattened in order", () => {
    const u = unit({
      hunks: [{ id: "h1", heart: [{ why: "Enqueue", lines: [214, 261] }, { why: "Process", lines: [300, 340] }] }, "h2"],
    });
    expect(heartSegments(u)).toEqual([
      { id: "h1", why: "Enqueue", lines: [214, 261] },
      { id: "h1", why: "Process", lines: [300, 340] },
    ]);
    expect(() => unit({ hunks: [{ id: "h1", heart: [{ why: "a" }, { why: "b" }, { why: "c" }, { why: "d" }] }] })).toThrow();
  });

  it("a whole-hunk segment must be the hunk's only one", () => {
    expect(() => unit({ hunks: [{ id: "h1", heart: [{ why: "all" }, { why: "part", lines: [1, 3] }] }] })).toThrow(
      /must be its only segment/,
    );
  });

  it("rejects overlapping segments on one hunk", () => {
    expect(() => unit({ hunks: [{ id: "h1", heart: [{ why: "a", lines: [10, 20] }, { why: "b", lines: [20, 30] }] }] })).toThrow(
      /overlap/,
    );
    expect(() => unit({ hunks: [{ id: "h1", heart: [{ why: "a", lines: [10, 20] }, { why: "b", lines: [21, 30] }] }] })).not.toThrow();
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
        hunks: [
          { id: "h1", heart: [{ why: "the rule" }] },
          { id: "h2", heart: [{ why: "its guard" }] },
        ],
      }),
    ],
    unassigned: [],
  });

  it("folds through analysis-set", () => {
    const state = fold([rev(1), analysis()]);
    expect(heartOf(state.units[0])).toHaveLength(2);
  });

  it("loses the entry of a hunk a patch takes out of the unit", () => {
    const state = fold([
      rev(1),
      analysis(),
      { ts, type: "unit-updated", unitId: "u1", patch: { hunks: [{ id: "h1", heart: [{ why: "the rule" }] }] } },
    ]);
    expect(state.units[0].hunks).toEqual([{ id: "h1", heart: [{ why: "the rule" }] }]);
  });

  it("a full-list resend of bare ids clears the hearts", () => {
    const state = fold([rev(1), analysis(), { ts, type: "unit-updated", unitId: "u1", patch: { hunks: ["h1"] } }]);
    expect(state.units[0].hunks).toEqual([{ id: "h1" }]);
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
    expect(hunkIdsOf(state.units[0])).toEqual(["h1b"]);
    expect(state.units[0].hunks).toEqual([{ id: "h1b", heart: [{ why: "the rule" }] }]);
  });

  it("keeps segment ranges through an identical match and collapses them when the hunk was reworked", () => {
    const withLines: ReviewerEvent = {
      ts,
      type: "analysis-set",
      revision: 1,
      summary: "s",
      units: [
        unit({
          hunks: [
            { id: "h1", signals: [{ flag: "money", why: "Duplicate charge.", lines: [3, 9] }, { flag: "auth", why: "Access leaks.", lines: [20, 25] }, { flag: "duplication", why: "Repeats the guard.", lines: [3, 9] }, { flag: "test-gap", why: "No retry coverage." }], heart: [{ why: "the rule", lines: [3, 9] }, { why: "its helper", lines: [20, 25] }] },
            { id: "h2", signals: [{ flag: "security", why: "Secret leaks.", lines: [1, 2] }, { flag: "abstraction", why: "Guard hides the policy.", lines: [1, 2] }], heart: [{ why: "its guard", lines: [1, 2] }] },
            { id: "h3", signals: [{ flag: "intent-drift", why: "Changes unrelated policy." }] },
          ],
        }),
      ],
      unassigned: [],
    };
    const migration = {
      revision: 2,
      previousRevision: 1,
      baseOnly: false,
      counts: { identical: 1, fuzzy: 1, renamed: 1, archived: 0, new: 0 },
      entries: [
        { status: "fuzzy", hunkId: "h1b", previousHunkId: "h1", file: "a.ts", score: 0.8 },
        { status: "identical", hunkId: "h2", previousHunkId: "h2", file: "a.ts" },
        { status: "renamed", hunkId: "h3b", previousHunkId: "h3", file: "b.ts" },
      ],
    };
    const state = fold([
      rev(1),
      withLines,
      { ...(rev(2, ["h1b", "h2", "h3b"]) as Record<string, unknown>), migration } as unknown as ReviewerEvent,
    ]);
    expect(state.units[0].hunks).toEqual([
      { id: "h1b", signals: [{ flag: "money", why: "Duplicate charge." }, { flag: "auth", why: "Access leaks." }], heart: [{ why: "the rule" }] },
      { id: "h2", signals: [{ flag: "security", why: "Secret leaks.", lines: [1, 2] }, { flag: "abstraction", why: "Guard hides the policy.", lines: [1, 2] }], heart: [{ why: "its guard", lines: [1, 2] }] },
      { id: "h3b" },
    ]);
  });

  it("has no heart once every heart hunk left the PR", () => {
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
    expect(heartOf(state.units[0])).toEqual([]);
    expect(state.units[0].removedAtRevision).toBe(2);
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

  const payload = (alphaHunks?: unknown) => ({
    summary: "s",
    units: [
      { ...unit({ id: "alpha", hunks: [a1, a2] }), ...(alphaHunks ? { hunks: alphaHunks } : {}) },
      unit({ id: "beta", hunks: [b1], order: 2 }),
    ],
    unassigned: [],
  });

  it("derives risk flags for analysis and patches, ignoring sent flags", () => {
    const signals = [{ flag: "money", why: "A retry can charge twice.", lines: [1, 1] }];
    const input = payload([{ id: a1, signals }, a2]);
    input.units[0].riskFlags = ["security"];
    expect(setAnalysis(key, input, {}, tmp).state.units[0].riskFlags).toEqual(["money"]);
    expect(setUnit(key, "alpha", { riskFlags: ["security"], addHunks: [{ id: a2, signals: [{ flag: "auth", why: "Access can leak." }] }] }, undefined, tmp).units[0].riskFlags).toEqual(["money", "auth"]);
    expect(() => setUnit(key, "alpha", { addHunks: [{ id: a1, signals: [{ ...signals[0], flag: "duplication", lines: [1, 2] }] }] }, undefined, tmp)).toThrow(/bounds/);
    expect(() => setAnalysis(key, payload([{ id: a1, signals: [{ ...signals[0], flag: "test-gap", lines: [2, 2] }] }, a2]), {}, tmp)).toThrow(/bounds/);
    expect(setAnalysis(key, payload([{ id: a1, signals: [{ flag: "duplication", why: "Repeats the rule." }] }, a2]), {}, tmp).state.units[0].riskFlags).toEqual([]);
    expect(setUnit(key, "alpha", { addHunks: [{ id: a1, signals }] }, undefined, tmp).units[0].riskFlags).toEqual(["money"]);
    expect(setUnit(key, "alpha", { addHunks: [{ id: a1, signals: [{ flag: "test-gap", why: "No retry coverage." }] }] }, undefined, tmp).units[0].riskFlags).toEqual([]);
  });

  it("set-analysis accepts a heart entry, resolving short ids", () => {
    const { state } = setAnalysis(key, payload([a1, { id: a2.slice(0, 8), heart: [{ why: "the rule" }] }]), {}, tmp);
    expect(state.units[0].hunks).toEqual([{ id: a1 }, { id: a2, heart: [{ why: "the rule" }] }]);
  });

  it("set-analysis rejects a heart hunk that belongs to another unit, naming it", () => {
    expect(() => setAnalysis(key, payload([a1, a2, { id: b1, heart: [{ why: "wrong unit" }] }]), {}, tmp)).toThrow(
      new RegExp(`${b1}: alpha, beta`),
    );
  });

  it("set-analysis rejects a fourth heart hunk, naming the unit", () => {
    expect(() =>
      setAnalysis(
        key,
        {
          summary: "s",
          units: [{ ...unit({ id: "alpha" }), hunks: [a1, a2, b1, "ffffffffffffffff"].map((id) => ({ id, heart: [{ why: "w" }] })) }],
          unassigned: [],
        },
        {},
        tmp,
      ),
    ).toThrow(/at most 3/);
  });

  it("set-unit marks a heart through addHunks with short ids judged on the list after the patch", () => {
    setAnalysis(key, payload(), {}, tmp);
    const { state } = setUnits(
      key,
      [
        { unitId: "beta", payload: { removeHunkIds: [b1] } },
        { unitId: "alpha", payload: { addHunks: [{ id: b1.slice(0, 8), heart: [{ why: "moved in" }] }] } },
      ],
      tmp,
    );
    expect(heartOf(state.units[0])).toEqual([{ id: b1, segments: [{ why: "moved in" }] }]);
    expect(hunkIdsOf(state.units[0])).toEqual([a1, a2, b1]);
  });

  it("set-analysis and set-unit carry segment ranges and refuse a backwards or overlapping one", () => {
    const heart = (lines: [number, number]) => [{ id: a1, heart: [{ why: "the rule", lines }] }, a2];
    const { state } = setAnalysis(key, payload(heart([4, 20])), {}, tmp);
    expect(heartSegments(state.units[0])).toEqual([{ id: a1, why: "the rule", lines: [4, 20] }]);
    expect(() => setAnalysis(key, payload(heart([20, 4])), {}, tmp)).toThrow();
    expect(() => setUnit(key, "alpha", { addHunks: [{ id: a1, heart: [{ why: "x", lines: [20, 4] }] }] }, {}, tmp)).toThrow(
      /lines/,
    );
    expect(() =>
      setUnit(key, "alpha", { addHunks: [{ id: a1, heart: [{ why: "x", lines: [1, 5] }, { why: "y", lines: [5, 9] }] }] }, {}, tmp),
    ).toThrow(/overlap/);
    const patched = setUnit(
      key,
      "alpha",
      { addHunks: [{ id: a2, heart: [{ why: "x", lines: [1, 1] }, { why: "y", lines: [3, 4] }] }] },
      {},
      tmp,
    );
    expect(heartSegments(patched.units[0])).toEqual([
      { id: a1, why: "the rule", lines: [4, 20] },
      { id: a2, why: "x", lines: [1, 1] },
      { id: a2, why: "y", lines: [3, 4] },
    ]);
  });

  it("set-unit refuses a heart hunk another unit holds, and an unknown one", () => {
    setAnalysis(key, payload(), {}, tmp);
    expect(() => setUnit(key, "alpha", { addHunks: [{ id: b1, heart: [{ why: "x" }] }] }, {}, tmp)).toThrow(
      /would belong to more than one unit/,
    );
    expect(() => setUnit(key, "alpha", { addHunks: [{ id: "ffffffffffff", heart: [{ why: "x" }] }] }, {}, tmp)).toThrow(
      /addHunks entry "ffffffffffff" is not a hunk of revision 1/,
    );
  });
});
