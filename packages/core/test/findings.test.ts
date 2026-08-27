import { afterAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fold } from "../src/reducer.js";
import { setAnalysis, setUnit } from "../src/service.js";
import { appendEvent, writeMeta, writeRevision } from "../src/store.js";
import { computeHunkId } from "../src/hunk-id.js";
import { toRevisionFiles } from "../src/migration.js";
import type { FileDiff, PrKey } from "../src/index.js";
import {
  FindingSchema,
  ReviewUnitSchema,
  StateSchema,
  type ReviewerEvent,
  type ReviewUnit,
} from "../src/schemas.js";

const ts = "2026-01-01T00:00:00.000Z";

const warning = {
  severity: "warning" as const,
  text: "handleRefund ignores the new ErrRateLimited and falls through to success.",
  evidence: "internal/billing/refund.go:212",
};
const note = {
  severity: "note" as const,
  text: "All 3 callers map both error paths to 403.",
  evidence: "internal/api/handler.go:88, internal/vep/client.go:41",
};

function unit(over: Partial<ReviewUnit> = {}): ReviewUnit {
  return ReviewUnitSchema.parse({
    id: "u1",
    title: "Unit",
    summary: "Summary",
    kind: "core-logic",
    attention: "must-read",
    attentionWhy: "why",
    riskFlags: [],
    hunkIds: ["h1"],
    order: 1,
    ...over,
  });
}

describe("Finding schema", () => {
  it("round-trips a warning and a note on a unit", () => {
    const u = unit({ findings: [warning, note] });
    expect(ReviewUnitSchema.parse(JSON.parse(JSON.stringify(u)))).toEqual(u);
  });

  it("rejects empty evidence", () => {
    expect(FindingSchema.safeParse({ ...note, evidence: "" }).success).toBe(false);
    // ...and a missing one, which is the same mistake spelled differently.
    expect(FindingSchema.safeParse({ severity: "note", text: "x" }).success).toBe(false);
  });

  it("rejects empty text, over-long text/evidence, and unknown severities", () => {
    expect(FindingSchema.safeParse({ ...note, text: "" }).success).toBe(false);
    expect(FindingSchema.safeParse({ ...note, text: "x".repeat(301) }).success).toBe(false);
    expect(FindingSchema.safeParse({ ...note, evidence: "e".repeat(201) }).success).toBe(false);
    expect(FindingSchema.safeParse({ ...note, severity: "error" }).success).toBe(false);
    expect(FindingSchema.safeParse({ ...note, text: "x".repeat(300) }).success).toBe(true);
  });

  it("caps a unit at 5 findings", () => {
    expect(ReviewUnitSchema.safeParse({ ...unit(), findings: Array(5).fill(note) }).success).toBe(
      true,
    );
    expect(ReviewUnitSchema.safeParse({ ...unit(), findings: Array(6).fill(note) }).success).toBe(
      false,
    );
  });

  it("parses units and state written before findings existed", () => {
    const legacy = { ...unit() };
    delete (legacy as Record<string, unknown>).findings;
    const parsed = ReviewUnitSchema.parse(legacy);
    expect(parsed.findings).toBeUndefined();
    expect(StateSchema.parse({ currentRevision: 1, units: [legacy] }).units[0].findings).toBeUndefined();
  });
});

describe("findings through the reducer", () => {
  const rev = (revision: number) =>
    ({
      ts,
      type: "revision-added",
      revision,
      baseSha: `b${revision}`,
      headSha: `h${revision}`,
      mergeBase: `m${revision}`,
      baseOnly: false,
      files: [{ path: "a.ts", hunkIds: ["h1", "h2"] }],
    }) as ReviewerEvent;

  const analysis = (findings = [warning, note]): ReviewerEvent => ({
    ts,
    type: "analysis-set",
    revision: 1,
    summary: "s",
    units: [
      unit({ id: "u1", hunkIds: ["h1"], findings }),
      unit({ id: "u2", hunkIds: ["h2"], order: 2, findings: [note] }),
    ],
    unassigned: [],
  });

  it("folds findings through analysis-set", () => {
    const state = fold([rev(1), analysis()]);
    expect(state.units[0].findings).toEqual([warning, note]);
    expect(state.units[1].findings).toEqual([note]);
  });

  it("replaces findings on a unit-updated patch, and drops them on an empty array", () => {
    const state = fold([
      rev(1),
      analysis(),
      { ts, type: "unit-updated", unitId: "u1", patch: { findings: [note] } },
      { ts, type: "unit-updated", unitId: "u2", patch: { findings: [] } },
    ]);
    expect(state.units[0].findings).toEqual([note]);
    expect(state.units[1].findings).toEqual([]);
  });

  it("keeps findings on a unit whose hunks all carried identical, and drops them otherwise", () => {
    const migration = {
      revision: 2,
      previousRevision: 1,
      baseOnly: false,
      counts: { identical: 1, fuzzy: 1, renamed: 0, archived: 0, new: 0 },
      entries: [
        // u1's hunk is byte-for-byte the same -> its findings still hold.
        { status: "identical", hunkId: "h1", previousHunkId: "h1", file: "a.ts" },
        // u2's hunk shifted -> whatever was verified about it is now stale.
        { status: "fuzzy", hunkId: "h2b", previousHunkId: "h2", file: "a.ts", score: 0.8 },
      ],
    };
    const state = fold([
      rev(1),
      analysis(),
      {
        ...(rev(2) as Record<string, unknown>),
        files: [{ path: "a.ts", hunkIds: ["h1", "h2b"] }],
        migration,
      } as unknown as ReviewerEvent,
    ]);
    const [u1, u2] = state.units;
    expect(u1.hunkIds).toEqual(["h1"]);
    expect(u1.findings).toEqual([warning, note]);
    expect(u2.hunkIds).toEqual(["h2b"]);
    expect(u2.findings).toBeUndefined();
  });

  it("drops findings when a unit's hunk was archived", () => {
    const migration = {
      revision: 2,
      previousRevision: 1,
      baseOnly: false,
      counts: { identical: 1, fuzzy: 0, renamed: 0, archived: 1, new: 0 },
      entries: [
        { status: "identical", hunkId: "h1", previousHunkId: "h1", file: "a.ts" },
        { status: "archived", hunkId: "h2", file: "a.ts", wasViewed: false },
      ],
    };
    const state = fold([
      rev(1),
      analysis(),
      {
        ...(rev(2) as Record<string, unknown>),
        files: [{ path: "a.ts", hunkIds: ["h1"] }],
        migration,
      } as unknown as ReviewerEvent,
    ]);
    expect(state.units[0].findings).toEqual([warning, note]);
    expect(state.units[1].findings).toBeUndefined();
  });

  it("leaves units without findings untouched by migration", () => {
    const migration = {
      revision: 2,
      previousRevision: 1,
      baseOnly: false,
      counts: { identical: 0, fuzzy: 1, renamed: 0, archived: 0, new: 1 },
      entries: [
        { status: "fuzzy", hunkId: "h1b", previousHunkId: "h1", file: "a.ts", score: 0.9 },
        { status: "new", hunkId: "h9", file: "a.ts" },
      ],
    };
    const state = fold([
      rev(1),
      {
        ts,
        type: "analysis-set",
        revision: 1,
        summary: "s",
        units: [unit({ id: "u1", hunkIds: ["h1"] })],
        unassigned: ["h2"],
      },
      {
        ...(rev(2) as Record<string, unknown>),
        files: [{ path: "a.ts", hunkIds: ["h1b", "h9"] }],
        migration,
      } as unknown as ReviewerEvent,
    ]);
    expect(state.units[0].findings).toBeUndefined();
    expect(state.units[0].hunkIds).toEqual(["h1b"]);
  });
});

describe("findings through the CLI-facing service", () => {
  const key: PrKey = { host: "github.com", owner: "acme", repo: "widgets", number: 42 };
  let tmp: string;
  let hunkId: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-findings-"));
    writeMeta(
      key,
      {
        host: key.host,
        owner: key.owner,
        repo: key.repo,
        number: key.number,
        url: "https://github.com/acme/widgets/pull/42",
        createdAt: ts,
        archived: false,
      },
      tmp,
    );
    hunkId = computeHunkId("src/a.ts", ["+b"], ["-a"]);
    const files: FileDiff[] = [
      {
        path: "src/a.ts",
        status: "modified",
        binary: false,
        hunks: [
          {
            id: hunkId,
            file: "src/a.ts",
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            header: "",
            addedLines: ["+b"],
            removedLines: ["-a"],
            text: "",
          },
        ],
      },
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

  afterAll(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  const payload = (findings?: unknown) => ({
    summary: "s",
    units: [{ ...unit({ hunkIds: [hunkId], findings: undefined }), findings }],
    unassigned: [],
  });

  it("set-analysis accepts findings and folds them into state", () => {
    const { state } = setAnalysis(key, payload([warning, note]), tmp);
    expect(state.units[0].findings).toEqual([warning, note]);
  });

  it("set-analysis rejects a finding with empty evidence", () => {
    expect(() => setAnalysis(key, payload([{ ...note, evidence: "" }]), tmp)).toThrow();
  });

  it("set-unit patches findings onto an existing unit without touching anything else", () => {
    setAnalysis(key, payload(undefined), tmp);
    const state = setUnit(key, "u1", { findings: [warning] }, {}, tmp);
    expect(state.units[0].findings).toEqual([warning]);
    expect(state.units[0].attention).toBe("must-read");
    expect(state.units[0].hunkIds).toEqual([hunkId]);
  });
});
