import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keyToString, type PrKey } from "../src/paths.js";
import { appendEvent, writeMeta, writeRevision } from "../src/store.js";
import { computeHunkId } from "../src/hunk-id.js";
import { toRevisionFiles } from "../src/migration.js";
import type { FileDiff, Hunk } from "../src/schemas.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const key: PrKey = {
  host: "github.com",
  owner: "acme",
  repo: "widgets",
  number: 42,
};

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
    text: [...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join(
      "\n",
    ),
  };
}

let tmp: string;

/** Seed a minimal, fully-initialized PR state (no `gh` calls involved). */
function seed(): { hunk: Hunk } {
  writeMeta(key, {
    host: key.host,
    owner: key.owner,
    repo: key.repo,
    number: key.number,
    url: "https://github.com/acme/widgets/pull/42",
    title: "Add widgets",
    createdAt: new Date().toISOString(),
  });
  appendEvent(key, {
    type: "pr-initialized",
    host: key.host,
    owner: key.owner,
    repo: key.repo,
    number: key.number,
    url: "https://github.com/acme/widgets/pull/42",
    title: "Add widgets",
  });

  const hunk = mkHunk("src/a.ts", ["  return a + b;"], ["  return a;"]);
  const files: FileDiff[] = [
    { path: "src/a.ts", status: "modified", binary: false, hunks: [hunk] },
  ];
  writeRevision(key, 1, "diff", files, {
    baseSha: "base1",
    headSha: "head1",
    mergeBase: "mb1",
  });
  appendEvent(key, {
    type: "revision-added",
    revision: 1,
    baseSha: "base1",
    headSha: "head1",
    mergeBase: "mb1",
    baseOnly: false,
    files: toRevisionFiles(files),
  });
  appendEvent(key, {
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
        attentionWhy: "why",
        riskFlags: [],
        hunkIds: [hunk.id],
        order: 0,
      },
    ],
  });
  return { hunk };
}

function eventCount(): number {
  const file = path.join(
    tmp,
    key.host,
    key.owner,
    key.repo,
    String(key.number),
    "events.jsonl",
  );
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0).length;
}

function run(
  args: string[],
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [cliPath, ...args], {
      encoding: "utf8",
      env: { ...process.env, REVIEWER_STATE_DIR: tmp },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status, stdout: e.stdout, stderr: e.stderr };
  }
}

beforeAll(() => {
  expect(
    fs.existsSync(cliPath),
    `dist/cli.js missing — run \`pnpm -r build\` first`,
  ).toBe(true);
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-cli-test-"));
  process.env.REVIEWER_STATE_DIR = tmp;
});
afterAll(() => {
  delete process.env.REVIEWER_STATE_DIR;
});

describe("cli view", () => {
  it("marks a real hunk viewed", () => {
    const { hunk } = seed();
    const res = run(["view", keyToString(key), hunk.id]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("marked viewed");
    expect(eventCount()).toBe(4); // pr-initialized, revision-added, analysis-set, hunk-viewed
  });

  it("exits 1 and writes nothing for an unknown hunk id", () => {
    seed();
    const before = eventCount();
    const res = run(["view", keyToString(key), "deadbeefdeadbeef"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/deadbeefdeadbeef/);
    expect(res.stderr).toMatch(/not part of revision/);
    expect(eventCount()).toBe(before);
  });

  it("exits 1 and writes nothing for an unknown unit id", () => {
    seed();
    const before = eventCount();
    const res = run(["view", keyToString(key), "unit:no-such-unit"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/no-such-unit/);
    expect(eventCount()).toBe(before);
  });
});

describe("cli set-unit", () => {
  it("requires the full schema when creating a brand-new unit, even if `kind` is just missing", () => {
    seed();
    const before = eventCount();
    const file = path.join(tmp, "new-unit.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        title: "New unit",
        summary: "s",
        // kind intentionally omitted
        attention: "skim",
        attentionWhy: "why",
        riskFlags: [],
        hunkIds: [],
        order: 1,
      }),
    );
    const res = run([
      "set-unit",
      keyToString(key),
      "--id",
      "brand-new",
      "--file",
      file,
    ]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/brand-new/);
    expect(res.stderr).toMatch(/kind/);
    // nothing should have been written
    expect(eventCount()).toBe(before);
  });

  it("creates a new unit when the full schema is provided", () => {
    seed();
    const file = path.join(tmp, "new-unit-full.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        title: "New unit",
        summary: "s",
        kind: "wiring",
        attention: "skim",
        attentionWhy: "why",
        riskFlags: [],
        hunkIds: [],
        order: 1,
      }),
    );
    const res = run([
      "set-unit",
      keyToString(key),
      "--id",
      "brand-new",
      "--file",
      file,
    ]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("brand-new");
    expect(res.stdout).toContain("skim/wiring");
  });

  it("treats a payload for an existing unit as a partial patch — no defaults injected", () => {
    seed();
    const file = path.join(tmp, "patch.json");
    // Only `attention` provided; `kind` deliberately absent.
    fs.writeFileSync(file, JSON.stringify({ attention: "skip" }));
    const res = run([
      "set-unit",
      keyToString(key),
      "--id",
      "core",
      "--file",
      file,
    ]);
    expect(res.status).toBe(0);
    // kind is unchanged from the original "core-logic", not reset to "wiring"
    expect(res.stdout).toContain("skip/core-logic");
  });
});
