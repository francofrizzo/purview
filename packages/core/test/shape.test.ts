import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileNoteProblems, setAnalysis, setShape } from "../src/service.js";
import { appendEvent, loadState, writeMeta, writeRevision } from "../src/store.js";
import { computeHunkId } from "../src/hunk-id.js";
import { toRevisionFiles } from "../src/migration.js";
import type { FileDiff, PrKey } from "../src/index.js";

/**
 * The shape of the change: the file notes the analysis writes, checked so
 * that every note sits on a file or folder of the revision; and the concepts,
 * kept free of code.
 */

const ts = "2026-01-01T00:00:00.000Z";

describe("fileNoteProblems", () => {
  it("refuses unknown and generated paths", () => {
    const problems = fileNoteProblems(
      { "src/a.ts": "ok", "pnpm-lock.yaml": "no", "src/nope.ts": "no" },
      new Set(["src/a.ts", "pnpm-lock.yaml"]),
      new Set(["pnpm-lock.yaml"]),
    ).join("\n");
    expect(problems).toContain('"pnpm-lock.yaml" is a generated file');
    expect(problems).toContain('"src/nope.ts" is not a file or folder of this revision');
    expect(problems).not.toContain("src/a.ts");
  });

  it("takes a folder that holds a file the reader reads, at any depth", () => {
    const paths = new Set(["internal/storage/sql/q.sql", "internal/storage/sqlc/q.sql.go", "web/x.ts"]);
    const generated = new Set(["internal/storage/sqlc/q.sql.go"]);
    const notes = { internal: "x", "internal/storage": "x", "internal/storage/sql": "x", "internal/storage/sqlc": "x", "internal/stor": "x" };
    const problems = fileNoteProblems(notes, paths, generated).join("\n");
    expect(problems).toContain('"internal/storage/sqlc" holds only generated files');
    expect(problems).toContain('"internal/stor" is not a file or folder of this revision');
    expect(problems.split("\n")).toHaveLength(2);
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

  it("keeps the analysis's notes, a folder's keyed without its slash, and a later analysis without them drops them", () => {
    setAnalysis(key, analysis({ fileNotes: { "src/": "Where charging lives.", "src/a.ts": "Charges once per key." } }), {}, tmp);
    let state = loadState(key, tmp);
    expect(state.fileNotes).toEqual({ src: "Where charging lives.", "src/a.ts": "Charges once per key." });
    expect(state.shapeRevision).toBe(1);
    setAnalysis(key, analysis(), {}, tmp);
    state = loadState(key, tmp);
    expect(state.fileNotes).toBeUndefined();
    expect(state.shapeRevision).toBeUndefined();
  });

  it("set-shape replaces one view against the revision's files, leaving the others", () => {
    setAnalysis(key, analysis({ fileNotes: { "src/a.ts": "Charges once per key." } }), {}, tmp);
    setShape(key, { concepts }, tmp);
    let state = loadState(key, tmp);
    expect(state.concepts).toHaveLength(1);
    // An absent key leaves its view as it was.
    expect(state.fileNotes).toEqual({ "src/a.ts": "Charges once per key." });
    expect(() => setShape(key, { fileNotes: { "src/gone.ts": "x" } }, tmp)).toThrow(/not a file or folder of this revision/);
    setShape(key, { fileNotes: null, concepts: null }, tmp);
    state = loadState(key, tmp);
    expect(state.fileNotes).toBeUndefined();
    expect(state.concepts).toBeUndefined();
    expect(state.shapeRevision).toBeUndefined();
  });

  it("refuses notes on files the revision lacks", () => {
    expect(() => setAnalysis(key, analysis({ fileNotes: { "src/b.ts": "x" } }), {}, tmp)).toThrow(
      /fileNotes: "src\/b.ts" is not a file or folder of this revision/,
    );
  });

  const concepts = [
    { term: "Charge key", means: "What makes two charges the same charge.", aka: ["idempotencyKey"], isNew: true },
  ];
  it("keeps the concepts like the other views, and set-shape drops them", () => {
    setAnalysis(key, analysis({ concepts }), {}, tmp);
    let state = loadState(key, tmp);
    expect(state.concepts?.[0]).toMatchObject({ term: "Charge key", aka: ["idempotencyKey"], isNew: true });
    expect(state.shapeRevision).toBe(1);
    setShape(key, { concepts: null }, tmp);
    state = loadState(key, tmp);
    expect(state.concepts).toBeUndefined();
  });

  it("keeps the reader's way in free of code: the summary and the concepts", () => {
    expect(() => setAnalysis(key, analysis({ summary: "Adds `charge_ledger`." }), {}, tmp)).toThrow(/summary: plain words only/);
    expect(() =>
      setAnalysis(key, analysis({ concepts: [{ term: "Key", means: "The `idempotencyKey()` value." }] }), {}, tmp),
    ).toThrow(/plain words only/);
    // The code's own names are where they belong: in `aka`, to be matched in the units.
    expect(() => setAnalysis(key, analysis({ concepts }), {}, tmp)).not.toThrow();
    // Another reader's exported analysis is taken as it is.
    expect(() => setAnalysis(key, analysis({ summary: "Adds `charge_ledger`." }), { origin: "import" }, tmp)).not.toThrow();
  });
});
