import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyAnalysisImport,
  buildAnalysisExport,
  type AnalysisExport,
} from "../src/analysis-share.js";
import { computeHunkId } from "../src/hunk-id.js";
import { setAnalysis } from "../src/service.js";
import { appendEvent, writeMeta, writeRevision } from "../src/store.js";
import { toRevisionFiles } from "../src/migration.js";
import type { FileDiff, Hunk, PrKey, ReviewUnit } from "../src/schemas.js";

const key: PrKey = {
  host: "github.com",
  owner: "acme",
  repo: "widgets",
  number: 42,
};

const otherKey: PrKey = { ...key, number: 43 };

function mkHunk(file: string, added: string[], removed: string[]): Hunk {
  return {
    id: computeHunkId(file, added, removed),
    file,
    oldStart: 1,
    oldLines: removed.length,
    newStart: 1,
    newLines: added.length,
    header: "",
    addedLines: added,
    removedLines: removed,
    text: [...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join("\n"),
  };
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "purview-analysis-share-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Seed a fully-initialized PR at revision 1 with `hunks`, no analysis yet. */
function seedPr(k: PrKey, hunks: Hunk[], root: string): void {
  writeMeta(
    k,
    {
      host: k.host,
      owner: k.owner,
      repo: k.repo,
      number: k.number,
      url: `https://github.com/${k.owner}/${k.repo}/pull/${k.number}`,
      title: "Add widgets",
      createdAt: new Date().toISOString(),
    },
    root,
  );
  appendEvent(
    k,
    {
      type: "pr-initialized",
      host: k.host,
      owner: k.owner,
      repo: k.repo,
      number: k.number,
      url: `https://github.com/${k.owner}/${k.repo}/pull/${k.number}`,
      title: "Add widgets",
    },
    root,
  );
  const files: FileDiff[] = [{ path: "src/a.ts", status: "modified", binary: false, hunks }];
  writeRevision(k, 1, "diff", files, { baseSha: "base1", headSha: "head1", mergeBase: "mb1" }, root);
  appendEvent(
    k,
    {
      type: "revision-added",
      revision: 1,
      baseSha: "base1",
      headSha: "head1",
      mergeBase: "mb1",
      baseOnly: false,
      files: toRevisionFiles(files),
    },
    root,
  );
}

/** Add a second revision that keeps `keep` hunks and adds `fresh` ones. */
function addRevision2(k: PrKey, keep: Hunk[], fresh: Hunk[], root: string): void {
  const files: FileDiff[] = [
    { path: "src/a.ts", status: "modified", binary: false, hunks: [...keep, ...fresh] },
  ];
  writeRevision(k, 2, "diff2", files, { baseSha: "base1", headSha: "head2", mergeBase: "mb1" }, root);
  appendEvent(
    k,
    {
      type: "revision-added",
      revision: 2,
      baseSha: "base1",
      headSha: "head2",
      mergeBase: "mb1",
      baseOnly: false,
      files: toRevisionFiles(files),
    },
    root,
  );
}

function mkUnit(over: Partial<ReviewUnit> = {}): ReviewUnit {
  return {
    id: "u1",
    title: "Core",
    summary: "Core logic changes.",
    kind: "core-logic",
    attention: "must-read",
    attentionWhy: "auth path",
    riskFlags: [],
    hunkIds: [],
    order: 0,
    ...over,
  };
}

describe("buildAnalysisExport", () => {
  it("throws when there is no analysis to export", () => {
    const h = mkHunk("src/a.ts", ["+a"], []);
    seedPr(key, [h], tmp);
    expect(() => buildAnalysisExport(key, tmp)).toThrow(/no analysis/i);
  });

  it("builds a versioned envelope from the current state", () => {
    const h = mkHunk("src/a.ts", ["+a"], []);
    seedPr(key, [h], tmp);
    setAnalysis(key, { summary: "Adds a.", units: [mkUnit({ hunkIds: [h.id] })] }, {}, tmp);

    const envelope = buildAnalysisExport(key, tmp);
    expect(envelope.format).toBe("purview-analysis");
    expect(envelope.version).toBe(1);
    expect(envelope.pr).toEqual({ host: key.host, owner: key.owner, repo: key.repo, number: key.number });
    expect(envelope.revision).toBe(1);
    expect(envelope.headSha).toBe("head1");
    expect(envelope.units).toHaveLength(1);
    expect(envelope.summary).toBe("Adds a.");
  });
});

describe("applyAnalysisImport", () => {
  it("round-trips into a fresh copy of the same state: identical units", () => {
    const h1 = mkHunk("src/a.ts", ["+a"], []);
    const h2 = mkHunk("src/a.ts", ["+b"], []);
    seedPr(key, [h1, h2], tmp);
    setAnalysis(
      key,
      { summary: "Adds a and b.", units: [mkUnit({ hunkIds: [h1.id, h2.id] })] },
      {},
      tmp,
    );
    const envelope = buildAnalysisExport(key, tmp);

    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "purview-analysis-share-importer-"));
    try {
      seedPr(key, [h1, h2], otherRoot);
      const { state, report } = applyAnalysisImport(key, envelope, otherRoot);
      expect(report).toEqual({
        unitsImported: 1,
        unitsDropped: 0,
        hunksMatched: 2,
        hunksUnassigned: 0,
        sameRevision: true,
      });
      expect(state.units).toEqual(envelope.units);
      expect(state.unassignedHunkIds).toEqual([]);
      expect(state.analysisOrigin).toBe("import");
    } finally {
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it("revision drift: extra importer hunks land unassigned, missing ones are dropped", () => {
    const h1 = mkHunk("src/a.ts", ["+a"], []);
    const h2 = mkHunk("src/a.ts", ["+b"], []);
    seedPr(key, [h1, h2], tmp);
    setAnalysis(
      key,
      {
        summary: "Adds a and b.",
        units: [mkUnit({ id: "u1", hunkIds: [h1.id] }), mkUnit({ id: "u2", hunkIds: [h2.id], order: 1 })],
      },
      {},
      tmp,
    );
    const envelope = buildAnalysisExport(key, tmp);

    // Importer is on a later revision: h1 survived, h2 is gone, h3 is new.
    const h3 = mkHunk("src/a.ts", ["+c"], []);
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "purview-analysis-share-drift-"));
    try {
      seedPr(key, [h1, h2], otherRoot);
      addRevision2(key, [h1], [h3], otherRoot);
      const { state, report } = applyAnalysisImport(key, envelope, otherRoot);

      expect(report.unitsImported).toBe(1); // u2 dropped (h2 no longer in current revision)
      expect(report.unitsDropped).toBe(1);
      expect(report.hunksMatched).toBe(1); // h1
      expect(report.hunksUnassigned).toBe(1); // h3
      expect(report.sameRevision).toBe(false);

      expect(state.units.map((u) => u.id)).toEqual(["u1"]);
      expect(state.units[0].hunkIds).toEqual([h1.id]);
      expect(state.unassignedHunkIds).toEqual([h3.id]);
    } finally {
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it("rejects an envelope for a different PR", () => {
    const h = mkHunk("src/a.ts", ["+a"], []);
    seedPr(key, [h], tmp);
    setAnalysis(key, { summary: "s", units: [mkUnit({ hunkIds: [h.id] })] }, {}, tmp);
    const envelope = buildAnalysisExport(key, tmp);

    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "purview-analysis-share-wrongpr-"));
    try {
      seedPr(otherKey, [h], otherRoot);
      expect(() => applyAnalysisImport(otherKey, envelope, otherRoot)).toThrow(/not.*cannot import|for .*not/i);
    } finally {
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it("rejects a malformed / wrong-version envelope", () => {
    const h = mkHunk("src/a.ts", ["+a"], []);
    seedPr(key, [h], tmp);
    expect(() => applyAnalysisImport(key, { format: "purview-analysis", version: 2 }, tmp)).toThrow();
    expect(() => applyAnalysisImport(key, { not: "an envelope" }, tmp)).toThrow();
  });

  it("strips machine-local fields: nothing about viewed state rides along", () => {
    const h1 = mkHunk("src/a.ts", ["+a"], []);
    seedPr(key, [h1], tmp);
    setAnalysis(key, { summary: "s", units: [mkUnit({ hunkIds: [h1.id] })] }, {}, tmp);
    const envelope = buildAnalysisExport(key, tmp) as AnalysisExport & Record<string, unknown>;
    // The wire shape has no "hunks"/"viewed" projection at all — only units.
    expect(Object.keys(envelope).sort()).toEqual(
      ["exportedAt", "format", "headSha", "mergeBase", "pr", "revision", "summary", "units", "version"].sort(),
    );
  });
});
