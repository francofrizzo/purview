import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileNoteProblems, flowProblems, setAnalysis, setShape } from "../src/service.js";
import { appendEvent, loadState, writeMeta, writeRevision } from "../src/store.js";
import { computeHunkId } from "../src/hunk-id.js";
import { toRevisionFiles } from "../src/migration.js";
import type { FileDiff, PrKey } from "../src/index.js";
import { FlowSchema, type Flow } from "../src/schemas.js";

/**
 * The shape of the change: the flow and the file notes the analysis writes,
 * checked so that every step lands on a participant, every unit named is real,
 * and every note sits on a file of the revision.
 */

const ts = "2026-01-01T00:00:00.000Z";

function flow(over: Partial<Flow> = {}): Flow {
  return FlowSchema.parse({
    participants: [
      { id: "route", label: "POST /pay" },
      { id: "charge", label: "charge()", status: "changed", units: ["u1"] },
    ],
    steps: [
      { from: "route", to: "charge", label: "charge(order)" },
      { from: "charge", to: "route", label: "result", kind: "return", status: "added", units: ["u1"] },
    ],
    ...over,
  });
}

describe("flowProblems", () => {
  const units = new Set(["u1"]);
  it("passes a sound flow", () => {
    expect(flowProblems(flow(), units)).toEqual([]);
  });
  it("names steps to unknown participants, unknown units, bad phases and an unchanged flow", () => {
    const bad = flow({
      steps: [
        { from: "route", to: "ghost", label: "x", kind: "call", status: "added", units: ["u9"] },
      ],
      phases: [
        { label: "late", at: 3 },
        { label: "early", at: 0 },
      ],
    });
    const problems = flowProblems(bad, units).join("\n");
    expect(problems).toContain('unknown participant "ghost"');
    expect(problems).toContain('unknown unit "u9"');
    expect(problems).toContain("past the last step");
    expect(problems).toContain("must start after the phase before it");
    const flat = flow({
      participants: [
        { id: "a", label: "A", status: "context", units: [] },
        { id: "b", label: "B", status: "context", units: [] },
      ],
      steps: [{ from: "a", to: "b", label: "x", kind: "call", status: "context", units: [] }],
    });
    expect(flowProblems(flat, units).join("\n")).toContain("nothing in the flow is added");
  });

  it("wants every step and piece the PR touches to name its unit, so a click on it leads somewhere", () => {
    const orphan = flow({
      steps: [{ from: "route", to: "charge", label: "charge(order)", kind: "call", status: "added", units: [] }],
    });
    expect(flowProblems(orphan, new Set(["u1"])).join("\n")).toContain('step 0 (charge(order)) is added but names no unit');
    const piece = flow({
      participants: [
        { id: "route", label: "POST /pay", status: "changed", units: [] },
        { id: "charge", label: "charge()", status: "changed", units: ["u1"] },
      ],
    });
    expect(flowProblems(piece, new Set(["u1"])).join("\n")).toContain('participant "route" is changed but names no unit');
  });
});

describe("fileNoteProblems", () => {
  it("refuses unknown and generated paths", () => {
    const problems = fileNoteProblems(
      { "src/a.ts": "ok", "pnpm-lock.yaml": "no", "src/nope.ts": "no" },
      new Set(["src/a.ts", "pnpm-lock.yaml"]),
      new Set(["pnpm-lock.yaml"]),
    ).join("\n");
    expect(problems).toContain('"pnpm-lock.yaml" is a generated file');
    expect(problems).toContain('"src/nope.ts" is not a file of this revision');
    expect(problems).not.toContain("src/a.ts");
  });
});

describe("the shape through the service", () => {
  const key: PrKey = { host: "github.com", owner: "acme", repo: "widgets", number: 44 };
  let tmp: string;
  let h1: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-shape-"));
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
    const added = ["charge()"];
    h1 = computeHunkId("src/a.ts", added, []);
    const files: FileDiff[] = [
      {
        path: "src/a.ts",
        status: "modified",
        binary: false,
        hunks: [
          {
            id: h1,
            file: "src/a.ts",
            oldStart: 1,
            oldLines: 0,
            newStart: 1,
            newLines: 1,
            header: "",
            addedLines: added,
            removedLines: [],
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

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const analysis = (extra: Record<string, unknown> = {}) => ({
    summary: "s",
    units: [
      {
        id: "u1",
        title: "Charge",
        summary: "s",
        kind: "core-logic",
        attention: "must-read",
        attentionWhy: "w",
        hunkIds: [h1],
        order: 1,
      },
    ],
    ...extra,
  });

  it("keeps the analysis's flow and notes, and a later analysis without them drops them", () => {
    setAnalysis(key, analysis({ flow: flow(), fileNotes: { "src/a.ts": "Charges once per key." } }), {}, tmp);
    let state = loadState(key, tmp);
    expect(state.flow?.participants.map((p) => p.id)).toEqual(["route", "charge"]);
    expect(state.shapeRevision).toBe(1);
    setAnalysis(key, analysis(), {}, tmp);
    state = loadState(key, tmp);
    expect(state.flow).toBeUndefined();
    expect(state.fileNotes).toBeUndefined();
    expect(state.shapeRevision).toBeUndefined();
  });

  it("refuses an analysis whose flow names a unit it does not have", () => {
    const bad = flow({
      participants: [
        { id: "a", label: "A", status: "added", units: ["nope"] },
        { id: "b", label: "B", status: "context", units: [] },
      ],
      steps: [{ from: "a", to: "b", label: "x", kind: "call", status: "added", units: [] }],
    });
    expect(() => setAnalysis(key, analysis({ flow: bad }), {}, tmp)).toThrow(/flow: participant "a": unknown unit "nope"/);
    expect(loadState(key, tmp).units).toEqual([]);
  });

  it("set-shape replaces one view against the live units and the revision's files, leaving the other", () => {
    setAnalysis(key, analysis({ fileNotes: { "src/a.ts": "Charges once per key." } }), {}, tmp);
    setShape(key, { flow: flow({ caption: "the path" }) }, tmp);
    let state = loadState(key, tmp);
    expect(state.flow?.caption).toBe("the path");
    // An absent key leaves its view as it was.
    expect(state.fileNotes).toEqual({ "src/a.ts": "Charges once per key." });
    expect(() =>
      setShape(key, { flow: flow({ steps: [{ from: "route", to: "charge", label: "x", kind: "call", status: "added", units: ["u2"] }] }) }, tmp),
    ).toThrow(/unknown unit "u2"/);
    expect(() => setShape(key, { fileNotes: { "src/gone.ts": "x" } }, tmp)).toThrow(/not a file of this revision/);
    setShape(key, { flow: null, fileNotes: null }, tmp);
    state = loadState(key, tmp);
    expect(state.flow).toBeUndefined();
    expect(state.fileNotes).toBeUndefined();
    expect(state.shapeRevision).toBeUndefined();
  });

  it("refuses notes on files the revision lacks", () => {
    expect(() => setAnalysis(key, analysis({ fileNotes: { "src/b.ts": "x" } }), {}, tmp)).toThrow(
      /fileNotes: "src\/b.ts" is not a file of this revision/,
    );
  });

  const concepts = [
    { term: "Charge key", means: "What makes two charges the same charge.", aka: ["idempotencyKey"], isNew: true },
  ];
  const example = {
    case: "A client retries a charge that already went through",
    before: ["The gateway charges the card a second time."],
    after: ["The ledger has the key, so the first result comes back.", "The card is charged once."],
  };

  it("keeps the concepts and the example like the other views, and set-shape redraws or drops them", () => {
    setAnalysis(key, analysis({ concepts, example }), {}, tmp);
    let state = loadState(key, tmp);
    expect(state.concepts?.[0]).toMatchObject({ term: "Charge key", aka: ["idempotencyKey"], isNew: true });
    expect(state.example?.after).toHaveLength(2);
    expect(state.shapeRevision).toBe(1);
    setShape(key, { example: null }, tmp);
    state = loadState(key, tmp);
    expect(state.example).toBeUndefined();
    expect(state.concepts).toHaveLength(1);
  });

  it("keeps the reader's way in free of code: the summary, the concepts and the example", () => {
    expect(() => setAnalysis(key, analysis({ summary: "Adds `charge_ledger`." }), {}, tmp)).toThrow(/summary: plain words only/);
    expect(() =>
      setAnalysis(key, analysis({ concepts: [{ term: "Key", means: "The `idempotencyKey()` value." }] }), {}, tmp),
    ).toThrow(/plain words only/);
    expect(() => setShape(key, { example: { ...example, case: "`retry()` twice" } }, tmp)).toThrow(/plain words only/);
    // The code's own names are where they belong: in `aka`, to be matched in the units.
    expect(() => setAnalysis(key, analysis({ concepts }), {}, tmp)).not.toThrow();
    // Another reader's exported analysis is taken as it is.
    expect(() => setAnalysis(key, analysis({ summary: "Adds `charge_ledger`." }), { origin: "import" }, tmp)).not.toThrow();
  });
});
