import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * scripts/analysis-metrics.mjs is a dev tool, driven here as a black box
 * against a hand-written log in a temp state dir (`--json` output).
 */

const SCRIPT = fileURLToPath(new URL("../../../scripts/analysis-metrics.mjs", import.meta.url));

let root: string;
let prDir: string;

const oldMetrics = {
  turns: 10,
  durationMs: 120_000,
  costUsd: 1,
  toolCalls: { Bash: 2 },
  bash: { cli: 1, state: 0, grep: 1, sed: 0, other: 0 },
  reads: { filesJson: 0, diffPatch: 0, skill: 1, checkout: 0, other: 0 },
};

function writeLog(events: Record<string, unknown>[]): void {
  fs.writeFileSync(
    path.join(prDir, "events.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
}

function run(...args: string[]): any {
  const out = execFileSync(process.execPath, [SCRIPT, "--json", ...args], {
    env: { ...process.env, PURVIEW_STATE_DIR: root },
    encoding: "utf8",
  });
  return JSON.parse(out);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-metrics-script-"));
  prDir = path.join(root, "github.com", "acme", "widgets", "7");
  fs.mkdirSync(path.join(prDir, "revisions", "1"), { recursive: true });
  // Revision 1's size is only knowable from files.json: its run predates run.size.
  fs.writeFileSync(
    path.join(prDir, "revisions", "1", "files.json"),
    JSON.stringify({
      revision: 1,
      files: [
        { path: "a.ts", hunks: [{ addedLines: ["x", "y", "z"], removedLines: ["w"] }] },
        { path: "b.ts", hunks: [{ addedLines: ["q"], removedLines: [] }] },
      ],
    }),
  );
  // Managed checkouts live beside PR dirs and are never mistaken for one.
  fs.mkdirSync(path.join(root, "checkouts", "github.com", "acme", "widgets", "7"), { recursive: true });

  const unitPatch = (ts: string, patch: Record<string, unknown>) => ({ ts, type: "unit-updated", unitId: "u1", patch });
  const corrected = (ts: string) => ({ ts, type: "classification-corrected", hunkId: "h", from: "must-read", to: "skim", note: "" });
  writeLog([
    { ts: "2026-09-01T10:00:00.000Z", type: "revision-added", revision: 1 },
    { ts: "2026-09-01T10:00:01.000Z", type: "analysis-started", revision: 1 },
    // The agent's own reclassification, inside its run's bracket: not an outcome.
    unitPatch("2026-09-01T10:01:00.000Z", { kind: "wiring" }),
    corrected("2026-09-01T10:01:00.000Z"),
    { ts: "2026-09-01T10:02:00.000Z", type: "analysis-finished", revision: 1, status: "done", metrics: oldMetrics },
    // The reader's edits afterwards: one reclassify (two hunks), one retitle.
    unitPatch("2026-09-01T11:00:00.000Z", { attention: "skim" }),
    corrected("2026-09-01T11:00:00.000Z"),
    corrected("2026-09-01T11:00:00.000Z"),
    unitPatch("2026-09-01T11:05:00.000Z", { title: "renamed" }),
    { ts: "2026-09-05T10:00:00.000Z", type: "revision-added", revision: 2 },
    // After the new revision and before the next run: belongs to no run.
    corrected("2026-09-05T10:00:30.000Z"),
    { ts: "2026-09-05T10:00:01.000Z", type: "analysis-started", revision: 2 },
    {
      ts: "2026-09-05T10:05:00.000Z",
      type: "analysis-finished",
      revision: 2,
      status: "done",
      metrics: {
        ...oldMetrics,
        durationMs: 300_000,
        costUsd: 2,
        run: {
          kind: "refresh",
          sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          cwd: prDir,
          model: "opus",
          resolvedModel: "claude-opus-4-6",
          effort: "high",
          promptVersion: "0123456789ab",
          size: { files: 4, hunks: 8, added: 150, removed: 50 },
          migration: { identical: 5, fuzzy: 2, renamed: 0, archived: 1, new: 1, changedUnits: 2 },
        },
      },
    },
    corrected("2026-09-05T12:00:00.000Z"),
    // A reconciled restart carries no metrics and is not a row.
    { ts: "2026-09-06T10:00:00.000Z", type: "analysis-finished", revision: 2, status: "failed", error: "server restarted" },
  ]);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("analysis-metrics script", () => {
  it("lists one row per metrics-bearing run, old ones with blank run columns", () => {
    const rows = run();
    expect(rows).toHaveLength(2);
    const [first, second] = rows;

    expect(first).toMatchObject({ key: "github.com/acme/widgets/7", revision: 1, status: "done" });
    expect(first.kind).toBeUndefined();
    expect(first.model).toBeUndefined();
    expect(first.transcript).toBeUndefined();
    // Size falls back to files.json: 2 files, 2 hunks, +4 -1.
    expect(first.size).toEqual({ files: 2, hunks: 2, added: 4, removed: 1 });
    expect(first.minPer100).toBeCloseTo(40); // 2 min over 5 lines
    // The reader's reclassify counts; the agent's own and the retitle do not.
    expect(first.corrections).toBe(2);
    expect(first.edits).toBe(1);

    expect(second).toMatchObject({
      kind: "refresh",
      model: "claude-opus-4-6",
      effort: "high",
      promptVersion: "0123456789ab",
      migration: { fuzzy: 2, changedUnits: 2 },
      corrections: 1,
      edits: 0,
    });
    expect(second.costPer100).toBeCloseTo(1); // $2 over 200 lines
    expect(second.transcript).toBe(
      path.join(
        os.homedir(),
        ".claude",
        "projects",
        prDir.replace(/[^a-zA-Z0-9]/g, "-"),
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl",
      ),
    );
  });

  it("filters by kind and date, and groups", () => {
    expect(run("--kind", "refresh").map((r: any) => r.revision)).toEqual([2]);
    expect(run("--kind", "initial")).toEqual([]);
    expect(run("--since", "2026-09-03").map((r: any) => r.revision)).toEqual([2]);
    expect(run("--until", "2026-09-03").map((r: any) => r.revision)).toEqual([1]);
    const groups = run("--group", "kind");
    expect(groups.map((g: any) => [g.value, g.runs])).toEqual(
      expect.arrayContaining([
        ["refresh", 1],
        ["-", 1],
      ]),
    );
  });

  it("prints an aligned table without --json", () => {
    const out = execFileSync(process.execPath, [SCRIPT, "--transcripts"], {
      env: { ...process.env, PURVIEW_STATE_DIR: root },
      encoding: "utf8",
    });
    expect(out.split("\n")[0]).toMatch(/^#\s+key\s+rev\s+finished\s+status\s+kind\s+model/);
    expect(out).toContain("claude-opus-4-6");
    expect(out).toContain("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl  (missing)");
  });
});
