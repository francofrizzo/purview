import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keyToString, type PrKey } from "../src/paths.js";
import { appendEvent, loadState, readEvents, writeMeta, writeMigrationReport, writeRevision } from "../src/store.js";
import { computeHunkId } from "../src/hunk-id.js";
import { migrate, toRevisionFiles } from "../src/migration.js";
import type { FileDiff, Hunk } from "../src/schemas.js";

/**
 * The unit-patching commands (set-unit add/remove, set-units batches, units)
 * and the refresh fetch helpers (show --needs / unit:, spill TOC), driven
 * through the built CLI against a temp state root.
 */

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const key: PrKey = { host: "github.com", owner: "acme", repo: "widgets", number: 7 };
const K = keyToString(key);

let tmp: string;

function mkHunk(file: string, added: string[], removed: string[] = []): Hunk {
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

function run(args: string[]): { status: number; stdout: string; stderr: string } {
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

function writeJson(name: string, value: unknown): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function eventLines(): number {
  return readEvents(key, tmp).length;
}

const unit = (id: string, hunkIds: string[], extra: Record<string, unknown> = {}) => ({
  id,
  title: `Title ${id}`,
  summary: "s",
  kind: "core-logic" as const,
  attention: "must-read" as const,
  attentionWhy: "why",
  riskFlags: [],
  hunkIds,
  order: 0,
  ...extra,
});

/**
 * r1: a.ts (a1, a2), b.ts (b1), c.ts (c1). Units: alpha = a1,a2; beta = b1.
 * c1 is in no unit (needs classification).
 */
function init() {
  writeMeta(key, {
    host: key.host,
    owner: key.owner,
    repo: key.repo,
    number: key.number,
    url: "https://github.com/acme/widgets/pull/7",
    title: "t",
    createdAt: new Date().toISOString(),
  });
}

function seed() {
  init();
  appendEvent(key, {
    type: "pr-initialized",
    host: key.host,
    owner: key.owner,
    repo: key.repo,
    number: key.number,
    url: "https://github.com/acme/widgets/pull/7",
    title: "t",
  });
  const a1 = mkHunk("src/a.ts", ["a1()"]);
  const a2 = mkHunk("src/a.ts", ["a2()"]);
  const b1 = mkHunk("src/b.ts", ["b1()"]);
  const c1 = mkHunk("src/c.ts", ["c1()"]);
  const files: FileDiff[] = [
    { path: "src/a.ts", status: "modified", binary: false, hunks: [a1, a2] },
    { path: "src/b.ts", status: "modified", binary: false, hunks: [b1] },
    { path: "src/c.ts", status: "added", binary: false, hunks: [c1] },
  ];
  writeRevision(key, 1, "diff", files, { baseSha: "b", headSha: "h", mergeBase: "m" });
  appendEvent(key, {
    type: "revision-added",
    revision: 1,
    baseSha: "b",
    headSha: "h",
    mergeBase: "m",
    baseOnly: false,
    files: toRevisionFiles(files),
  });
  appendEvent(key, {
    type: "unit-updated",
    unitId: "alpha",
    patch: unit("alpha", [a1.id, a2.id], { findings: [{ severity: "note", text: "ok", evidence: "a.ts:1" }] }),
  });
  appendEvent(key, { type: "unit-updated", unitId: "beta", patch: unit("beta", [b1.id], { order: 1 }) });
  return { a1, a2, b1, c1, files };
}

beforeAll(() => {
  expect(fs.existsSync(cliPath), "dist/cli.js missing — run `pnpm -r build` first").toBe(true);
});
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-cli-units-"));
  process.env.REVIEWER_STATE_DIR = tmp;
});
afterAll(() => {
  delete process.env.REVIEWER_STATE_DIR;
});

const unitOf = (id: string) => loadState(key, tmp).units.find((u) => u.id === id)!;

describe("set-unit addHunkIds / removeHunkIds", () => {
  it("adds and removes in place, accepting short ids, and prints what remains", () => {
    const { a1, a2, c1 } = seed();
    const res = run([
      "set-unit", K, "--id", "alpha",
      "--file", writeJson("p.json", { addHunkIds: [c1.id.slice(0, 8)], removeHunkIds: [a2.id] }),
    ]);
    expect(res.status).toBe(0);
    expect(unitOf("alpha").hunkIds).toEqual([a1.id, c1.id]);
    // a2 left alpha and is in no unit now: it is what remains.
    expect(res.stdout).toContain("Still needs classification (1):");
    expect(res.stdout).toContain(`${a2.id.slice(0, 8)} src/a.ts`);
  });

  it("says all hunks are assigned once nothing is left", () => {
    const { c1 } = seed();
    const res = run(["set-unit", K, "--id", "beta", "--file", writeJson("p.json", { addHunkIds: [c1.id] })]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("All hunks assigned");
  });

  it("rejects hunkIds together with add/remove, and unknown or too-short ids, writing nothing", () => {
    const { a1, c1 } = seed();
    const before = eventLines();
    const both = run([
      "set-unit", K, "--id", "alpha",
      "--file", writeJson("p.json", { hunkIds: [a1.id], addHunkIds: [c1.id] }),
    ]);
    expect(both.status).toBe(1);
    expect(both.stderr).toContain("not both");
    const unknown = run(["set-unit", K, "--id", "alpha", "--file", writeJson("q.json", { addHunkIds: ["ffffffffffff"] })]);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('addHunkIds entry "ffffffffffff" is not a hunk of revision 1');
    const short = run(["set-unit", K, "--id", "alpha", "--file", writeJson("r.json", { addHunkIds: ["abc"] })]);
    expect(short.status).toBe(1);
    expect(short.stderr).toContain("at least 6 chars");
    expect(eventLines()).toBe(before);
  });

  it("refuses to add a hunk another unit owns", () => {
    const { b1 } = seed();
    const before = eventLines();
    const res = run(["set-unit", K, "--id", "alpha", "--file", writeJson("p.json", { addHunkIds: [b1.id] })]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`${b1.id}: alpha, beta`);
    expect(eventLines()).toBe(before);
  });

  it("warns (without failing) about removing a hunk the unit does not hold", () => {
    const { c1 } = seed();
    const res = run(["set-unit", K, "--id", "alpha", "--file", writeJson("p.json", { removeHunkIds: [c1.id] })]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`warning: unit alpha did not hold ${c1.id}`);
  });
});

describe("set-units", () => {
  it("moves a hunk between units in one batch, in either order, with a per-patch note", () => {
    const { a1, a2, b1 } = seed();
    const res = run([
      "set-units", K,
      "--file",
      writeJson("batch.json", {
        units: [
          // added first, removed second: ownership is judged on the batch's result
          { id: "beta", addHunkIds: [a2.id], attention: "skim", note: "plumbing only" },
          { id: "alpha", removeHunkIds: [a2.id], changelogEntry: "split out the helper" },
        ],
      }),
    ]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("Unit beta saved: [skim/core-logic]");
    expect(res.stdout).toContain("Unit alpha saved:");
    expect(unitOf("alpha").hunkIds).toEqual([a1.id]);
    expect(unitOf("beta").hunkIds).toEqual([b1.id, a2.id]);
    expect(unitOf("alpha").changelog).toEqual([{ revision: 1, text: "split out the helper" }]);
    const corrected = loadState(key, tmp).corrections;
    // beta's pre-batch hunk gets the correction, with the patch's own note
    expect(corrected).toEqual([expect.objectContaining({ hunkId: b1.id, from: "must-read", to: "skim", note: "plumbing only" })]);
  });

  it("is all-or-nothing: one invalid patch writes nothing and every problem is named", () => {
    const { a2, b1, c1 } = seed();
    const before = eventLines();
    const res = run([
      "set-units", K,
      "--file",
      writeJson("batch.json", {
        units: [
          { id: "alpha", summary: "fine on its own" },
          { id: "beta", addHunkIds: [a2.id] }, // a2 still owned by alpha
          { id: "gamma", addHunkIds: [c1.id] }, // create without the full schema
        ],
      }),
    ]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Nothing was written.");
    expect(res.stderr).toContain('Unit "gamma" does not exist yet');
    expect(eventLines()).toBe(before);
    expect(unitOf("alpha").summary).toBe("s");

    // Clash on its own (valid schema everywhere) is also caught before writing.
    const clash = run([
      "set-units", K,
      "--file", writeJson("clash.json", { units: [{ id: "alpha", summary: "x" }, { id: "beta", addHunkIds: [a2.id] }] }),
    ]);
    expect(clash.status).toBe(1);
    expect(clash.stderr).toContain(`${a2.id}: alpha, beta`);
    expect(eventLines()).toBe(before);
    void b1;
  });

  it("creates a unit from a full entry and rejects a unit patched twice", () => {
    const { c1 } = seed();
    const ok = run([
      "set-units", K,
      "--file", writeJson("ok.json", { units: [unit("gamma", [c1.id], { kind: "tests", attention: "skim", order: 2 })] }),
    ]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(unitOf("gamma").hunkIds).toEqual([c1.id]);
    expect(ok.stdout).toContain("All hunks assigned");

    const twice = run([
      "set-units", K,
      "--file", writeJson("twice.json", { units: [{ id: "alpha", summary: "a" }, { id: "alpha", title: "b" }] }),
    ]);
    expect(twice.status).toBe(1);
    expect(twice.stderr).toContain("patched twice");
  });

  it("rejects a malformed file", () => {
    seed();
    const res = run(["set-units", K, "--file", writeJson("bad.json", { alpha: {} })]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('{"units": [');
  });
});

describe("units", () => {
  it("lists every unit with short ids by file and findings count, and filters by id", () => {
    const { a1, a2, b1 } = seed();
    const res = run(["units", K]);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(
      [
        "alpha  [must-read/core-logic]  Title alpha  (2 hunks, 1 finding)",
        `    src/a.ts: ${a1.id.slice(0, 8)} ${a2.id.slice(0, 8)}`,
        "beta  [must-read/core-logic]  Title beta  (1 hunk)",
        `    src/b.ts: ${b1.id.slice(0, 8)}`,
        "",
      ].join("\n"),
    );
    const one = run(["units", K, "beta", "nope"]);
    expect(one.stdout).not.toContain("alpha");
    expect(one.stdout).toContain("beta");
    expect(one.status).toBe(1);
    expect(one.stderr).toContain("unknown unit(s): nope");
  });

  it("marks husks", () => {
    const { a1, a2, b1, c1, files } = seed();
    // r2 drops b.ts entirely: beta becomes a husk.
    const next = files.filter((f) => f.path !== "src/b.ts");
    writeRevision(key, 2, "diff", next, { baseSha: "b2", headSha: "h2", mergeBase: "m2" });
    const report = migrate({ revision: 2, previousRevision: 1, previousFiles: files, nextFiles: next });
    writeMigrationReport(key, report);
    appendEvent(key, {
      type: "revision-added",
      revision: 2,
      baseSha: "b2",
      headSha: "h2",
      mergeBase: "m2",
      baseOnly: false,
      files: toRevisionFiles(next),
      migration: report,
    });
    const res = run(["units", K]);
    expect(res.stdout).toContain("~ beta  [must-read/core-logic]  Title beta  (0 hunks; husk: every hunk left the PR in r2)");
    void a1, a2, b1, c1;
  });
});

describe("show --needs and unit:<id>", () => {
  it("--needs prints exactly the hunks needing classification; unit: a unit's hunks", () => {
    const { a1, a2, b1, c1 } = seed();
    const needs = run(["show", K, "--needs"]);
    expect(needs.status).toBe(0);
    expect(needs.stdout).toContain(c1.id);
    expect(needs.stdout).not.toContain(a1.id);
    expect(needs.stdout).toContain("-- 1 hunks, 1 files");

    const byUnit = run(["show", K, "unit:alpha", b1.id]);
    expect(byUnit.status).toBe(0);
    for (const h of [a1, a2, b1]) expect(byUnit.stdout).toContain(h.id);
    expect(byUnit.stdout).not.toContain(c1.id);

    const unknown = run(["show", K, "unit:nope"]);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("unit:nope");
  });

  it("--needs with nothing to classify says so", () => {
    const { c1 } = seed();
    run(["set-unit", K, "--id", "beta", "--file", writeJson("p.json", { addHunkIds: [c1.id] })]);
    const res = run(["show", K, "--needs"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("nothing needs classification");
  });
});

describe("show spill table of contents", () => {
  it("prints per-file line ranges and hunk start lines that match the spilled file", () => {
    init();
    appendEvent(key, {
      type: "pr-initialized",
      host: key.host,
      owner: key.owner,
      repo: key.repo,
      number: key.number,
      url: "u",
      title: "t",
    });
    const files: FileDiff[] = ["x", "y"].map((name) => ({
      path: `src/${name}.ts`,
      status: "modified",
      binary: false,
      hunks: [0, 1].map((k) =>
        mkHunk(`src/${name}.ts`, Array.from({ length: 200 }, (_, i) => `const ${name}${k}_${i} = "${"q".repeat(40)}";`)),
      ),
    }));
    writeRevision(key, 1, "diff", files, { baseSha: "b", headSha: "h", mergeBase: "m" });
    appendEvent(key, {
      type: "revision-added",
      revision: 1,
      baseSha: "b",
      headSha: "h",
      mergeBase: "m",
      baseOnly: false,
      files: toRevisionFiles(files),
    });
    const res = run(["show", K, "--all"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("too large to print inline");
    expect(res.stdout).toContain("Contents (line ranges in that file");
    const file = /Written to (\S+)/.exec(res.stdout)![1];
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const y = /L(\d+)-(\d+) \(\d+ lines\)  src\/y\.ts  (\S+)@L(\d+) (\S+)@L(\d+)/.exec(res.stdout);
    expect(y, res.stdout).toBeTruthy();
    const [, from, to, id0, at0, id1, at1] = y!;
    expect(lines[Number(from) - 1]).toMatch(/^=== src\/y\.ts /);
    expect(Number(at0)).toBe(Number(from));
    expect(lines[Number(at0) - 1]).toContain(`=== src/y.ts   ${id0}`);
    expect(lines[Number(at1) - 1]).toContain(`=== src/y.ts   ${id1}`);
    // the range ends on the blank line after y's last hunk, before the summary
    expect(lines[Number(to)]).toMatch(/^-- 4 hunks, 2 files/);
  });
});
