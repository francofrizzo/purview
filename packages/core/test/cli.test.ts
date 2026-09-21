import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keyToString, prCheckoutPath, type PrKey } from "../src/paths.js";
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
function seed(added: string[] = ["  return a + b;"]): { hunk: Hunk } {
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

  const hunk = mkHunk("src/a.ts", added, ["  return a;"]);
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

describe("cli triage", () => {
  it("renders the overview with the real invocation and key on the bodies: line", () => {
    const { hunk } = seed();
    const res = run(["triage", keyToString(key)]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("revision 1");
    expect(res.stdout).toContain(hunk.id);
    expect(res.stdout).toContain(`show ${keyToString(key)} <hunk-id|path|glob>...`);
    expect(res.stdout).toContain(cliPath);
  });
});

describe("cli show", () => {
  it("prints the matched hunk body and a trailing summary line", () => {
    const { hunk } = seed();
    const res = run(["show", keyToString(key), hunk.id]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`=== src/a.ts   ${hunk.id}`);
    expect(res.stdout).toContain("-  return a;");
    expect(res.stdout).toContain("-- 1 hunks, 1 files");
  });

  it("matches by a unique 6+ char id prefix and by exact file path", () => {
    const { hunk } = seed();
    const byPrefix = run(["show", keyToString(key), hunk.id.slice(0, 6)]);
    expect(byPrefix.stdout).toContain(hunk.id);
    const byPath = run(["show", keyToString(key), "src/a.ts"]);
    expect(byPath.stdout).toContain(hunk.id);
  });

  it("exits 1 and lists unknown selectors on stderr while still printing what matched", () => {
    const { hunk } = seed();
    const res = run(["show", keyToString(key), hunk.id, "no/such/file.ts"]);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain(hunk.id);
    expect(res.stderr).toContain("no/such/file.ts");
  });

  it("--all prints every hunk of the revision", () => {
    const { hunk } = seed();
    const res = run(["show", keyToString(key), "--all"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(hunk.id);
  });

  it("writes a result too large to print inline to the scratch dir and prints its path", () => {
    const big = Array.from({ length: 800 }, (_, i) => `  const line${i} = "${"x".repeat(30)}";`);
    const { hunk } = seed(big);
    const res = run(["show", keyToString(key), hunk.id]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("-- 1 hunks, 1 files");
    expect(res.stdout).toContain("too large to print inline");
    expect(res.stdout).not.toContain("line799");
    const file = /Written to (\S+)/.exec(res.stdout)?.[1];
    expect(file).toBeTruthy();
    expect(path.dirname(file!)).toBe(path.join(tmp, key.host, key.owner, key.repo, String(key.number), "scratch"));
    const written = fs.readFileSync(file!, "utf8");
    expect(written).toContain(`=== src/a.ts   ${hunk.id}`);
    expect(written).toContain("line799");

    // --inline opts out.
    const inline = run(["show", keyToString(key), hunk.id, "--inline"]);
    expect(inline.stdout).toContain("line799");
  });

  it("requires at least one selector without --all", () => {
    seed();
    const res = run(["show", keyToString(key)]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/at least one selector/);
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

describe("cli base-file", () => {
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const g = (args: string[], cwd: string) =>
    execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "pipe"] }).trim();

  /**
   * A git repo standing in for the managed checkout (base-file only needs the
   * objects, not a worktree), plus PR state whose merge base is its first
   * commit and whose files.json records modified/added/renamed files.
   */
  function seedWithCheckout(): { base: string; head: string } {
    const dir = prCheckoutPath(key, tmp);
    fs.mkdirSync(dir, { recursive: true });
    g(["init", "-q", "-b", "main"], dir);
    fs.writeFileSync(path.join(dir, "a.ts"), "base a\n");
    fs.writeFileSync(path.join(dir, "legacy.ts"), "legacy body\n");
    g(["add", "."], dir);
    g(["commit", "-q", "-m", "base"], dir);
    const base = g(["rev-parse", "HEAD"], dir);
    fs.writeFileSync(path.join(dir, "a.ts"), "head a\n");
    g(["mv", "legacy.ts", "modern.ts"], dir);
    fs.writeFileSync(path.join(dir, "added.ts"), "new file\n");
    g(["add", "."], dir);
    g(["commit", "-q", "-m", "head"], dir);
    const head = g(["rev-parse", "HEAD"], dir);

    writeMeta(key, {
      host: key.host,
      owner: key.owner,
      repo: key.repo,
      number: key.number,
      url: "https://github.com/acme/widgets/pull/42",
      createdAt: new Date().toISOString(),
      archived: false,
    });
    appendEvent(key, {
      type: "pr-initialized",
      host: key.host,
      owner: key.owner,
      repo: key.repo,
      number: key.number,
      url: "https://github.com/acme/widgets/pull/42",
    });
    const files: FileDiff[] = [
      { path: "a.ts", status: "modified", binary: false, hunks: [mkHunk("a.ts", ["head a"], ["base a"])] },
      { path: "added.ts", status: "added", binary: false, hunks: [mkHunk("added.ts", ["new file"], [])] },
      { path: "modern.ts", oldPath: "legacy.ts", status: "renamed", binary: false, hunks: [] },
    ];
    const shas = { baseSha: base, headSha: head, mergeBase: base };
    writeRevision(key, 1, "diff", files, shas);
    appendEvent(key, {
      type: "revision-added",
      revision: 1,
      ...shas,
      baseOnly: false,
      files: toRevisionFiles(files),
    });
    return { base, head };
  }

  it("prints a modified file as it was at the merge base", () => {
    seedWithCheckout();
    const res = run(["base-file", keyToString(key), "a.ts"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("base a\n");
  });

  it("maps a renamed file's new path to its old path, and accepts the old path too", () => {
    seedWithCheckout();
    const byNew = run(["base-file", keyToString(key), "modern.ts"]);
    expect(byNew.status).toBe(0);
    expect(byNew.stdout).toBe("legacy body\n");
    const byOld = run(["base-file", keyToString(key), "legacy.ts"]);
    expect(byOld.stdout).toBe("legacy body\n");
  });

  it("exits 1 for a file the PR added", () => {
    seedWithCheckout();
    const res = run(["base-file", keyToString(key), "added.ts"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("not present at base (added by this PR)");
    expect(res.stdout).toBe("");
  });

  it("explains a missing checkout", () => {
    seedWithCheckout();
    fs.rmSync(prCheckoutPath(key, tmp), { recursive: true, force: true });
    const res = run(["base-file", keyToString(key), "a.ts"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("No managed checkout");
  });
});
