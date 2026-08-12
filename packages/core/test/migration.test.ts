import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setGhRunner } from "../src/github.js";
import { initPr, refreshPr, setAnalysis, setHunkViewed } from "../src/service.js";
import { loadState, readFilesJson, rebuildState } from "../src/store.js";
import type { PrKey } from "../src/paths.js";
import { parseDiff } from "../src/parse-diff.js";
import { migrate } from "../src/migration.js";
import type { FileDiff, State } from "../src/schemas.js";

const fixture = (name: string) =>
  fs.readFileSync(
    fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
    "utf8",
  );

const REV1 = fixture("rev1.patch");
const REV2 = fixture("rev2.patch");
const REV3 = REV2 + fixture("rev3-extra.patch");

const key: PrKey = {
  host: "github.com",
  owner: "acme",
  repo: "widgets",
  number: 7,
};

/** Stubbed `gh`: no network, exercised only through the github.ts boundary. */
const remote = {
  baseSha: "base1",
  headSha: "head1",
  mergeBase: "mb1",
  diff: REV1,
};

function installGhStub() {
  setGhRunner((args) => {
    if (args[0] !== "api") throw new Error(`unexpected gh ${args.join(" ")}`);
    if (args.includes("-H")) return remote.diff; // v3.diff media type
    const endpoint = args[1];
    if (endpoint.includes("/compare/"))
      return JSON.stringify({ merge_base_commit: { sha: remote.mergeBase } });
    if (/\/pulls\/\d+$/.test(endpoint))
      return JSON.stringify({
        node_id: "PR_kwABC",
        number: key.number,
        title: "Add widgets",
        html_url: "https://github.com/acme/widgets/pull/7",
        state: "open",
        base: { ref: "main", sha: remote.baseSha },
        head: { ref: "feature", sha: remote.headSha },
      });
    throw new Error(`unexpected gh api ${endpoint}`);
  });
}

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-test-"));
  process.env.REVIEWER_STATE_DIR = tmp;
  installGhStub();
});
afterAll(() => {
  setGhRunner(null);
  delete process.env.REVIEWER_STATE_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Locate a hunk id by file + a distinctive line, so tests don't hardcode hashes. */
function hunkIdBy(files: FileDiff[], file: string, needle: string): string {
  const f = files.find((x) => x.path === file);
  if (!f) throw new Error(`no file ${file}`);
  const h = f.hunks.find((x) =>
    [...x.addedLines, ...x.removedLines].some((l) => l.includes(needle)),
  );
  if (!h) throw new Error(`no hunk in ${file} matching ${needle}`);
  return h.id;
}

describe("full migration scenario", () => {
  let r1: FileDiff[];
  let ids: Record<string, string>;
  let state: State;

  it("revision 1: init parses and stores the diff", () => {
    const res = initPr(key);
    expect(res.created).toBe(true);
    expect(res.revision).toBe(1);
    r1 = readFilesJson(key, 1).files;
    ids = {
      login: hunkIdBy(r1, "src/auth.ts", 'log("failed")'),
      logout: hunkIdBy(r1, "src/auth.ts", "metrics.inc()"),
      dup1: r1.find((f) => f.path === "src/dup.ts")!.hunks[0].id,
      dup2: r1.find((f) => f.path === "src/dup.ts")!.hunks[1].id,
      legacy: hunkIdBy(r1, "src/legacy.ts", "legacy()"),
      feature: hunkIdBy(r1, "src/new-feature.ts", "NAME"),
      docs: hunkIdBy(r1, "docs/readme.md", "intro line"),
    };
    expect(new Set(Object.values(ids)).size).toBe(7);
  });

  it("revision 1: analysis must cover every hunk", () => {
    const units = [
      {
        id: "auth",
        title: "Auth logging",
        summary: "Logs failures and audits logout.",
        kind: "core-logic" as const,
        attention: "must-read" as const,
        attentionWhy: "auth path",
        riskFlags: ["auth" as const],
        hunkIds: [ids.login, ids.logout],
        order: 0,
      },
      {
        id: "misc",
        title: "Helpers",
        summary: "Assertions and the new feature module.",
        kind: "connective-tissue" as const,
        attention: "skim" as const,
        attentionWhy: "shape only",
        riskFlags: [],
        hunkIds: [ids.dup1, ids.dup2, ids.feature],
        order: 1,
      },
      {
        id: "cleanup",
        title: "Drop legacy + docs",
        summary: "Removes dead code, refreshes docs.",
        kind: "docs" as const,
        attention: "skip" as const,
        attentionWhy: "mechanical",
        riskFlags: [],
        hunkIds: [ids.legacy, ids.docs],
        order: 2,
      },
    ];

    expect(() =>
      setAnalysis(key, { summary: "s", units: units.slice(0, 1) }),
    ).toThrow(/does not cover/);
    expect(() =>
      setAnalysis(key, {
        summary: "s",
        units,
        unassigned: ["deadbeefdeadbeef"],
      }),
    ).toThrow(/not in revision/);

    const res = setAnalysis(key, { summary: "Adds audit logging.", units });
    expect(res.coverage.missing).toEqual([]);
    expect(res.state.units).toHaveLength(3);
  });

  it("revision 1: partial viewing", () => {
    setHunkViewed(key, ids.login, true);
    setHunkViewed(key, ids.logout, true);
    setHunkViewed(key, ids.legacy, true);
    setHunkViewed(key, ids.docs, true);
    const s = loadState(key);
    expect(s.hunks[ids.login].viewed).toBe(true);
    expect(s.files.find((f) => f.path === "src/auth.ts")!.viewed).toBe(true);
    expect(s.files.find((f) => f.path === "src/dup.ts")!.viewed).toBe(false);
  });

  it("revision 2: migrates identical / fuzzy / renamed / archived / new", () => {
    remote.headSha = "head2";
    remote.diff = REV2;
    const res = refreshPr(key);
    expect(res.added).toBe(true);
    expect(res.revision).toBe(2);
    expect(res.baseOnly).toBe(false);
    state = res.state;

    const r2 = readFilesJson(key, 2).files;
    const report = res.report!;
    const entryFor = (id: string) =>
      report.entries.find((e) => e.hunkId === id)!;

    // identical: same content, same file (line numbers moved)
    const login2 = hunkIdBy(r2, "src/auth.ts", 'log("failed")');
    expect(login2).toBe(ids.login);
    expect(entryFor(login2).status).toBe("identical");
    expect(state.hunks[login2]).toMatchObject({
      viewed: true,
      changedSinceViewed: false,
      migration: "identical",
    });

    // fuzzy: edited after being viewed -> stays viewed, flagged as changed
    const logout2 = hunkIdBy(r2, "src/auth.ts", "clock.now()");
    expect(logout2).not.toBe(ids.logout);
    const fuzzy = entryFor(logout2);
    expect(fuzzy.status).toBe("fuzzy");
    expect(fuzzy.previousHunkId).toBe(ids.logout);
    expect(fuzzy.score).toBeGreaterThanOrEqual(0.6);
    expect(state.hunks[logout2]).toMatchObject({
      viewed: true,
      changedSinceViewed: true,
      migration: "fuzzy",
      predecessorId: ids.logout,
    });

    // renamed: docs/readme.md -> docs/guide.md, same content
    const docs2 = hunkIdBy(r2, "docs/guide.md", "intro line");
    expect(docs2).not.toBe(ids.docs);
    expect(entryFor(docs2)).toMatchObject({
      status: "renamed",
      previousHunkId: ids.docs,
      previousFile: "docs/readme.md",
    });
    expect(state.hunks[docs2]).toMatchObject({
      viewed: true,
      changedSinceViewed: false,
      migration: "renamed",
    });

    // archived: src/legacy.ts is gone from the diff
    expect(entryFor(ids.legacy)).toMatchObject({
      status: "archived",
      wasViewed: true,
    });
    expect(state.hunks[ids.legacy]).toBeUndefined();
    expect(state.archived).toEqual([
      {
        hunkId: ids.legacy,
        file: "src/legacy.ts",
        archivedAtRevision: 2,
        wasViewed: true,
      },
    ]);

    // new: a third hunk appeared in src/auth.ts
    const refresh2 = hunkIdBy(r2, "src/auth.ts", "isExpired");
    expect(entryFor(refresh2).status).toBe("new");
    expect(state.hunks[refresh2]).toMatchObject({
      viewed: false,
      migration: "new",
    });

    // duplicate hunks (#2) carry across untouched
    expect(entryFor(ids.dup1).status).toBe("identical");
    expect(entryFor(ids.dup2).status).toBe("identical");

    expect(report.counts).toEqual({
      identical: 4, // login, dup1, dup2, new-feature
      fuzzy: 1,
      renamed: 1,
      archived: 1,
      new: 1,
    });
  });

  it("revision 2: units are remapped onto the new hunk ids", () => {
    const auth = state.units.find((u) => u.id === "auth")!;
    const r2 = readFilesJson(key, 2).files;
    expect(auth.hunkIds).toContain(hunkIdBy(r2, "src/auth.ts", "clock.now()"));
    expect(auth.hunkIds).not.toContain(ids.logout);
    // the archived hunk is dropped from its unit
    const cleanup = state.units.find((u) => u.id === "cleanup")!;
    expect(cleanup.hunkIds).not.toContain(ids.legacy);
    expect(cleanup.hunkIds).toContain(hunkIdBy(r2, "docs/guide.md", "intro"));
    // the brand-new hunk belongs to no unit yet — the skill must classify it
    const assigned = new Set(state.units.flatMap((u) => u.hunkIds));
    expect(assigned.has(hunkIdBy(r2, "src/auth.ts", "isExpired"))).toBe(false);
  });

  it("state.json is derived: rebuilding from events reproduces it", () => {
    const snapshot = loadState(key);
    expect(rebuildState(key)).toEqual(snapshot);
    fs.rmSync(path.join(tmp, "github.com/acme/widgets/7/state.json"));
    expect(loadState(key)).toEqual(snapshot);
  });

  it("revision 3: a baseOnly revision defaults new hunks to skip", () => {
    remote.mergeBase = "mb2"; // head unchanged, base moved
    remote.diff = REV3;
    const res = refreshPr(key);
    expect(res.added).toBe(true);
    expect(res.revision).toBe(3);
    expect(res.baseOnly).toBe(true);
    expect(res.report!.baseOnly).toBe(true);

    const r3 = readFilesJson(key, 3).files;
    const configHunk = hunkIdBy(r3, "src/config.ts", "timeoutMs");
    expect(res.report!.entries.find((e) => e.hunkId === configHunk)!.status).toBe(
      "new",
    );
    expect(res.state.hunks[configHunk]).toMatchObject({
      migration: "new",
      viewed: false,
      defaultAttention: "skip",
      defaultAttentionWhy: "base moved",
    });
    // everything else carried over untouched
    expect(res.report!.counts.archived).toBe(0);
    expect(res.report!.counts.new).toBe(1);
  });

  it("refresh is a no-op when nothing moved", () => {
    const res = refreshPr(key);
    expect(res.added).toBe(false);
    expect(res.revision).toBe(3);
  });
});

describe("migrate (unit level)", () => {
  it("matches each new hunk to at most one old hunk", () => {
    const prev = parseDiff(REV1);
    const next = parseDiff(REV2);
    const report = migrate({
      revision: 2,
      previousRevision: 1,
      previousFiles: prev,
      nextFiles: next,
    });
    const usedOld = report.entries
      .map((e) => e.previousHunkId)
      .filter(Boolean) as string[];
    expect(new Set(usedOld).size).toBe(usedOld.length);
    const newIds = report.entries
      .filter((e) => e.status !== "archived")
      .map((e) => e.hunkId);
    expect(new Set(newIds).size).toBe(newIds.length);
  });

  it("does not fuzzy-match below the 0.6 threshold", () => {
    const prev = parseDiff(REV1);
    const rewritten = REV1.replace(
      /@@ -40,7 \+41,9 @@[\s\S]*?(?=diff --git)/,
      `@@ -40,7 +41,9 @@ export function logout(user: string) {
   const token = makeToken(user);
-  totally();
-  different();
+  content();
+  here();
   return token;
 }
`,
    );
    const report = migrate({
      revision: 2,
      previousRevision: 1,
      previousFiles: prev,
      nextFiles: parseDiff(rewritten),
    });
    expect(report.counts.archived).toBe(1);
    expect(report.counts.new).toBe(1);
  });
});
