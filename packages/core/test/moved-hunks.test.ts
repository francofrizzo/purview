import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withMoves } from "../src/migration.js";
import { fold } from "../src/reducer.js";
import { readEvents } from "../src/store.js";
import { eventsPath, filesJsonPath, type PrKey } from "../src/paths.js";
import type { MigrationEntry, ReviewerEvent } from "../src/schemas.js";

const ts = "2026-01-01T00:00:00.000Z";
const hunk = (id: string, newStart: number, newLines: number) => ({ id, newStart, newLines });

describe("withMoves", () => {
  it("says where an identical hunk sat and how far it moved, and nothing for one that stayed or changed", () => {
    const entries: MigrationEntry[] = [
      { status: "identical", hunkId: "h2", previousHunkId: "h2", file: "a.ts" },
      { status: "identical", hunkId: "h3", previousHunkId: "h3", file: "a.ts" },
      { status: "fuzzy", hunkId: "h1b", previousHunkId: "h1", file: "a.ts" },
    ];
    const out = withMoves(
      entries,
      [{ hunks: [hunk("h1", 1, 4), hunk("h2", 20, 6), hunk("h3", 60, 2)] }],
      [{ hunks: [hunk("h1b", 1, 9), hunk("h2", 25, 6), hunk("h3", 60, 2)] }],
    );
    expect(out[0].moved).toEqual({ from: [20, 25], by: 5 });
    expect(out[1].moved).toBeUndefined();
    expect(out[2].moved).toBeUndefined();
  });
});

const r1: ReviewerEvent[] = [
  { ts, type: "pr-initialized", host: "github.com", owner: "acme", repo: "w", number: 1, url: "u", title: "t" },
  {
    ts,
    type: "revision-added",
    revision: 1,
    baseSha: "b",
    headSha: "h1",
    mergeBase: "m",
    baseOnly: false,
    files: [{ path: "src/a.ts", hunkIds: ["h2"] }],
  },
  {
    ts,
    type: "analysis-set",
    revision: 1,
    summary: "s",
    unassigned: [],
    units: [
      {
        id: "core",
        title: "Core",
        summary: "s",
        kind: "core-logic",
        attention: "must-read",
        attentionWhy: "w",
        hunks: [{ id: "h2", heart: [{ why: "the rule", lines: [21, 23] }], risks: [{ flag: "money", why: "m", lines: [22, 22] }] }],
        findings: [
          { severity: "warning", text: "Line a.ts:22 rounds down.", evidence: "src/a.ts:21-23, src/a.ts:90, other.ts:22" },
        ],
        order: 1,
      },
    ],
  } as ReviewerEvent,
];

const r2 = (moved?: MigrationEntry["moved"]): ReviewerEvent => ({
  ts,
  type: "revision-added",
  revision: 2,
  baseSha: "b",
  headSha: "h2",
  mergeBase: "m",
  baseOnly: false,
  files: [{ path: "src/a.ts", hunkIds: ["h0", "h2"] }],
  migration: {
    revision: 2,
    previousRevision: 1,
    baseOnly: false,
    counts: { identical: 1, fuzzy: 0, renamed: 0, archived: 0, new: 1 },
    entries: [
      { status: "new", hunkId: "h0", file: "src/a.ts" },
      { status: "identical", hunkId: "h2", previousHunkId: "h2", file: "src/a.ts", ...(moved ? { moved } : {}) },
    ],
    positions: true,
  },
});

describe("a hunk that moved without changing", () => {
  it("carries its heart, its risk and the findings' citations of its lines to the new numbers", () => {
    const state = fold([...r1, r2({ from: [20, 25], by: 5 })]);
    const h = state.units[0].hunks[0];
    expect(h.heart).toEqual([{ why: "the rule", lines: [26, 28] }]);
    expect(h.risks).toEqual([{ flag: "money", why: "m", lines: [27, 27] }]);
    const [f] = state.units[0].findings!;
    // Inside the hunk: renumbered; outside it, or in another file: as written.
    expect(f.evidence).toBe("src/a.ts:26-28, src/a.ts:90, other.ts:22");
    expect(f.text).toBe("Line a.ts:27 rounds down.");
  });

  it("leaves everything as written when it stayed put", () => {
    const state = fold([...r1, r2()]);
    expect(state.units[0].hunks[0].heart).toEqual([{ why: "the rule", lines: [21, 23] }]);
    expect(state.units[0].findings![0].evidence).toBe("src/a.ts:21-23, src/a.ts:90, other.ts:22");
  });
});

describe("a revision recorded before reports said where hunks moved", () => {
  const key: PrKey = { host: "github.com", owner: "acme", repo: "w", number: 1 };
  let root = "";
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const filesJson = (revision: number, hunks: ReturnType<typeof hunk>[]) => ({
    revision,
    baseSha: "b",
    headSha: `h${revision}`,
    mergeBase: "m",
    files: [
      {
        path: "src/a.ts",
        status: "modified",
        binary: false,
        hunks: hunks.map((h) => ({ ...h, file: "src/a.ts", oldStart: h.newStart, oldLines: h.newLines, header: "", addedLines: [], removedLines: [], text: "" })),
      },
    ],
  });

  it("gets the moves from the revisions' files.json when the log is read, without rewriting the log", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "moved-"));
    const old = r2();
    if (old.type !== "revision-added") throw new Error();
    delete old.migration!.positions;
    const log = [...r1, old].map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.mkdirSync(path.dirname(eventsPath(key, root)), { recursive: true });
    fs.writeFileSync(eventsPath(key, root), log);
    for (const [n, hs] of [
      [1, [hunk("h2", 20, 6)]],
      [2, [hunk("h0", 1, 5), hunk("h2", 25, 6)]],
    ] as const) {
      fs.mkdirSync(path.dirname(filesJsonPath(key, n, root)), { recursive: true });
      fs.writeFileSync(filesJsonPath(key, n, root), JSON.stringify(filesJson(n, [...hs])));
    }
    const state = fold(readEvents(key, root));
    expect(state.units[0].hunks[0].heart).toEqual([{ why: "the rule", lines: [26, 28] }]);
    expect(fs.readFileSync(eventsPath(key, root), "utf8")).toBe(log);
  });
});

it("moves the marks once when the same revision is added twice", () => {
  const twice = r2({ from: [20, 25], by: 5 });
  const state = fold([...r1, twice, twice]);
  expect(state.units[0].hunks[0].heart).toEqual([{ why: "the rule", lines: [26, 28] }]);
});
