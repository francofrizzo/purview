import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { upcastAnalysisPayload, upcastEvent, upcastUnitPatch } from "../src/upcast.js";
import { fold } from "../src/reducer.js";
import { readEvents } from "../src/store.js";
import { eventsPath, type PrKey } from "../src/paths.js";
import { EventSchema, ReviewUnitSchema, type ReviewerEvent, type ReviewUnit } from "../src/schemas.js";

/**
 * The event upcaster (src/upcast.ts): one literal event from each era, and
 * what it reads as today. A shipped step is frozen, so a test here never
 * changes; a new shape adds a new era below.
 */

const ts = "2026-10-19T10:00:00.000Z";

const base = {
  id: "rounding",
  title: "Rounding",
  summary: "s",
  kind: "core-logic",
  attention: "must-read",
  attentionWhy: "w",
  riskFlags: [],
  order: 1,
};

describe("step 1: `fold` (units written up to 2026.10.19)", () => {
  const era = {
    ts,
    type: "analysis-set",
    revision: 1,
    summary: "s",
    units: [{ ...base, hunkIds: ["h1", "h2"], heart: [{ hunkId: "h1", why: "the rule" }], fold: [{ hunkId: "h2", why: "adds imports" }] }],
    unassigned: [],
  };

  it("reads `fold` as `skip` and then as a skip entry", () => {
    const up = upcastEvent(era) as { units: Record<string, unknown>[] };
    expect(up.units[0]).toEqual({
      ...base,
      hunks: [
        { id: "h1", heart: [{ why: "the rule" }] },
        { id: "h2", skip: true, label: "adds imports" },
      ],
    });
    expect(EventSchema.parse(up)).toMatchObject({ type: "analysis-set" });
  });

  it("`skip` wins over `fold` when both are present", () => {
    const both = { ...base, hunkIds: ["h1", "h2"], skip: [{ hunkId: "h1", why: "a" }], fold: [{ hunkId: "h2", why: "b" }] };
    const up = upcastAnalysisPayload({ summary: "s", units: [both], unassigned: [] }) as { units: Record<string, unknown>[] };
    expect(up.units[0].hunks).toEqual([{ id: "h1", skip: true, label: "a" }, { id: "h2" }]);
  });
});

describe("step 2: hunkIds/heart/skip (units written up to 2026.10.19.1)", () => {
  const analysisSet = {
    ts,
    type: "analysis-set",
    revision: 1,
    summary: "s",
    units: [
      {
        ...base,
        hunkIds: ["h1", "h2", "h3", "h4"],
        heart: [
          { hunkId: "h1", why: "the rule", lines: [3, 9] },
          { hunkId: "h3", why: "its guard" },
        ],
        skip: [{ hunkId: "h2", why: "adds imports" }],
      },
      { ...base, id: "wire", order: 2, hunkIds: ["h5"] },
      { ...base, id: "gen", origin: "generated", attention: "skip", order: 3, hunkIds: ["h6"] },
    ],
    unassigned: ["h7"],
  };

  it("folds the three fields into one `hunks` list, carrying why and lines", () => {
    const up = upcastEvent(analysisSet) as typeof analysisSet & { units: Record<string, unknown>[] };
    expect(up.units[0]).toEqual({
      ...base,
      hunks: [
        { id: "h1", heart: [{ why: "the rule", lines: [3, 9] }] },
        { id: "h2", skip: true, label: "adds imports" },
        { id: "h3", heart: [{ why: "its guard" }] },
        { id: "h4" },
      ],
    });
    expect(up.units[1]).toEqual({ ...base, id: "wire", order: 2, hunks: [{ id: "h5" }] });
    // The generated unit too.
    expect(up.units[2]).toMatchObject({ origin: "generated", hunks: [{ id: "h6" }] });
    expect(up.unassigned).toEqual(["h7"]);
    for (const u of up.units) {
      expect("hunkIds" in u || "heart" in u || "skip" in u).toBe(false);
    }
    expect(() => EventSchema.parse(up)).not.toThrow();
  });

  it("appends a heart or skip id outside hunkIds rather than dropping it, and resolves a short id", () => {
    const unit = {
      ...base,
      hunkIds: ["56dd2f084abdc862", "457c4422bedcb394"],
      heart: [{ hunkId: "457c4422", why: "w" }],
      skip: [{ hunkId: "zzzz", why: "stray" }],
    };
    const up = upcastAnalysisPayload({ summary: "s", units: [unit] }) as { units: { hunks: unknown }[] };
    expect(up.units[0].hunks).toEqual([
      { id: "56dd2f084abdc862" },
      { id: "457c4422bedcb394", heart: [{ why: "w" }] },
      { id: "zzzz", skip: true, label: "stray" },
    ]);
  });

  it("renames the list fields of a unit-updated patch", () => {
    const ev = { ts, type: "unit-updated", unitId: "rounding", patch: { hunkIds: ["h1", "h2"], summary: "x" } };
    expect(upcastEvent(ev)).toEqual({ ts, type: "unit-updated", unitId: "rounding", patch: { hunks: ["h1", "h2"], summary: "x" } });
    const add = { ts, type: "unit-updated", unitId: "rounding", patch: { addHunkIds: ["h9"], removeHunkIds: ["h1"] } };
    expect(upcastEvent(add)).toEqual({
      ts,
      type: "unit-updated",
      unitId: "rounding",
      patch: { addHunks: ["h9"], removeHunkIds: ["h1"] },
    });
  });

  it("applies a legacy heart/skip to the `hunks` the same patch sends", () => {
    const ev = {
      ts,
      type: "unit-updated",
      unitId: "rounding",
      patch: { hunkIds: ["h1", "h2", "h3"], heart: [{ hunkId: "h2", why: "the rule" }], skip: [{ hunkId: "h3", why: "imports" }] },
    };
    const up = upcastEvent(ev) as { patch: { hunks: unknown } };
    expect(up.patch).toEqual({
      hunks: [{ id: "h1" }, { id: "h2", heart: [{ why: "the rule" }] }, { id: "h3", skip: true, label: "imports" }],
    });
    expect(() => EventSchema.parse(up)).not.toThrow();
  });

  it("without the unit, a legacy heart on a patch becomes an addHunks upsert of the named entries", () => {
    const ev = { ts, type: "unit-updated", unitId: "rounding", patch: { heart: [{ hunkId: "h2", why: "the rule" }] } };
    expect((upcastEvent(ev) as { patch: unknown }).patch).toEqual({ addHunks: [{ id: "h2", heart: [{ why: "the rule" }] }] });
  });
});

describe("step 3: `hunks` entries with `role` (an unshipped intermediate; state.json snapshots and maybe an event carry it)", () => {
  const analysisSet = {
    ts,
    type: "analysis-set",
    revision: 1,
    summary: "s",
    units: [
      {
        ...base,
        hunks: [
          { id: "h1", role: "heart", label: "the rule", lines: [3, 9] },
          { id: "h2", role: "skip", label: "adds imports" },
          { id: "h3", label: "the test" },
          { id: "h4" },
        ],
      },
    ],
    unassigned: [],
  };

  it("maps a role to a one-segment heart or a skip, and drops the key", () => {
    const up = upcastEvent(analysisSet) as { units: Record<string, unknown>[] };
    expect(up.units[0].hunks).toEqual([
      { id: "h1", heart: [{ why: "the rule", lines: [3, 9] }] },
      { id: "h2", skip: true, label: "adds imports" },
      { id: "h3", label: "the test" },
      { id: "h4" },
    ]);
    expect(() => EventSchema.parse(up)).not.toThrow();
  });

  it("maps the entries of a patch's `hunks` and `addHunks` alike", () => {
    const ev = {
      ts,
      type: "unit-updated",
      unitId: "rounding",
      patch: { addHunks: ["h5", { id: "h1", role: "heart", label: "w" }], removeHunkIds: ["h2"] },
    };
    expect((upcastEvent(ev) as { patch: unknown }).patch).toEqual({
      addHunks: ["h5", { id: "h1", heart: [{ why: "w" }] }],
      removeHunkIds: ["h2"],
    });
    expect(upcastUnitPatch({ hunks: [{ id: "h1", role: "skip", label: "x" }] })).toEqual({ hunks: [{ id: "h1", skip: true, label: "x" }] });
  });
});

describe("upcastUnitPatch with the existing unit", () => {
  const existing: ReviewUnit = ReviewUnitSchema.parse({
    ...base,
    hunks: [
      { id: "56dd2f084abdc862", heart: [{ why: "old heart", lines: [1, 4] }] },
      { id: "457c4422bedcb394", skip: true, label: "imports" },
      { id: "a5e4d9a3c0ffee00", label: "the test" },
    ],
  });

  it("a legacy heart resend sets a heart on the named entry and clears it from the old heart", () => {
    const up = upcastUnitPatch({ heart: [{ hunkId: "a5e4d9a3", why: "new heart" }] }, existing);
    expect(up).toEqual({
      addHunks: [{ id: "56dd2f084abdc862" }, { id: "a5e4d9a3c0ffee00", label: "the test", heart: [{ why: "new heart" }] }],
    });
  });

  it("a legacy empty skip list clears every skip and its label; the heart stays", () => {
    expect(upcastUnitPatch({ skip: [] }, existing)).toEqual({ addHunks: [{ id: "457c4422bedcb394" }] });
  });

  it("merges with addHunkIds the same patch sends, the claim entry winning", () => {
    const up = upcastUnitPatch({ addHunkIds: ["cdefbd6512345678", "a5e4d9a3c0ffee00"], heart: [{ hunkId: "a5e4d9a3c0ffee00", why: "w" }] }, existing);
    expect(up).toEqual({
      addHunks: [{ id: "cdefbd6512345678" }, { id: "56dd2f084abdc862" }, { id: "a5e4d9a3c0ffee00", label: "the test", heart: [{ why: "w" }] }],
    });
  });

  it("with no unit and no list, the named entries are an upsert (never a list replace)", () => {
    expect(upcastUnitPatch({ ...base, heart: [{ hunkId: "h1", why: "w" }] })).toEqual({
      ...base,
      addHunks: [{ id: "h1", heart: [{ why: "w" }] }],
    });
  });
});

describe("idempotence", () => {
  const current = [
    {
      ts,
      type: "analysis-set",
      revision: 1,
      summary: "s",
      units: [{ ...base, hunks: [{ id: "h1", heart: [{ why: "w" }] }, "h2", { id: "h3", skip: true, label: "x" }] }],
      unassigned: [],
    },
    { ts, type: "unit-updated", unitId: "rounding", patch: { addHunks: [{ id: "h3", skip: true, label: "x" }], removeHunkIds: ["h2"] } },
    { ts, type: "hunk-viewed", hunkId: "h1", revision: 1 },
    { ts, type: "revision-added", revision: 1, baseSha: "b", headSha: "h", mergeBase: "m", baseOnly: false, files: [] },
  ];

  it("passes a current event through as the same object", () => {
    for (const ev of current) expect(upcastEvent(ev)).toBe(ev);
    const payload = { summary: "s", units: current[0].units, unassigned: [] };
    expect(upcastAnalysisPayload(payload)).toBe(payload);
    const patch = { hunks: ["h1"], addHunks: undefined };
    expect(upcastUnitPatch(patch)).toBe(patch);
  });

  it("applying the upcaster twice is the same as once", () => {
    const old = { ts, type: "analysis-set", revision: 1, summary: "s", units: [{ ...base, hunkIds: ["h1"], fold: [{ hunkId: "h1", why: "x" }] }], unassigned: [] };
    const once = upcastEvent(old);
    expect(upcastEvent(once)).toBe(once);
  });
});

describe("readEvents on an events.jsonl written in older shapes", () => {
  const key: PrKey = { host: "github.com", owner: "acme", repo: "widgets", number: 7 };
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-upcast-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const rev = { ts, type: "revision-added", revision: 1, baseSha: "b", headSha: "h", mergeBase: "m", baseOnly: false, files: [{ path: "a.ts", hunkIds: ["h1", "h2", "h3"] }] };
  const old = [
    rev,
    {
      ts,
      type: "analysis-set",
      revision: 1,
      summary: "s",
      units: [{ ...base, hunkIds: ["h1", "h2", "h3"], heart: [{ hunkId: "h1", why: "the rule" }], fold: [{ hunkId: "h2", why: "imports" }] }],
      unassigned: [],
    },
    { ts, type: "unit-updated", unitId: "rounding", patch: { hunkIds: ["h1", "h2"], heart: [{ hunkId: "h1", why: "the rule" }], skip: [{ hunkId: "h2", why: "imports" }] } },
    // An event appended under the intermediate `role` shape.
    { ts, type: "unit-updated", unitId: "rounding", patch: { addHunks: [{ id: "h3", role: "skip", label: "re-export" }] } },
    { ts, type: "hunk-viewed", hunkId: "h1", revision: 1 },
  ];
  const current: ReviewerEvent[] = [
    rev as ReviewerEvent,
    {
      ts,
      type: "analysis-set",
      revision: 1,
      summary: "s",
      units: [ReviewUnitSchema.parse({ ...base, hunks: [{ id: "h1", heart: [{ why: "the rule" }] }, { id: "h2", skip: true, label: "imports" }, "h3"] })],
      unassigned: [],
    },
    { ts, type: "unit-updated", unitId: "rounding", patch: { hunks: [{ id: "h1", heart: [{ why: "the rule" }] }, { id: "h2", skip: true, label: "imports" }] } },
    { ts, type: "unit-updated", unitId: "rounding", patch: { addHunks: [{ id: "h3", skip: true, label: "re-export" }] } },
    { ts, type: "hunk-viewed", hunkId: "h1", revision: 1 },
  ];

  it("rebuilds the same state as the log in the new shape", () => {
    const file = eventsPath(key, tmp);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, old.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const events = readEvents(key, tmp);
    for (const e of events) expect(() => EventSchema.parse(e)).not.toThrow();
    const fromOld = fold(events);
    const fromNew = fold(current);
    expect(fromOld).toEqual(fromNew);
    expect(fromOld.units[0].hunks).toEqual([
      { id: "h1", heart: [{ why: "the rule" }] },
      { id: "h2", skip: true, label: "imports" },
      { id: "h3", skip: true, label: "re-export" },
    ]);
    expect(fromOld.hunks.h1.viewed).toBe(true);
    // The log itself is untouched.
    expect(fs.readFileSync(file, "utf8")).toContain('"hunkIds"');
  });
});
