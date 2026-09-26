import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  keyToString,
  prCheckoutPath,
  readMeta,
  readRepoConfig,
  repoConfigPath,
  setGhRunner,
  updateMeta,
  writeMeta,
  writeRepoConfig,
  type GhRunner,
  type PrKey,
} from "@reviewer/core";
import { createApp } from "../src/app.js";
import { analysisIdle } from "../src/analysis.js";
import { pruneCheckouts } from "../src/pr-checkout.js";
import {
  archiveSource,
  autoAnalyzeAllowed,
  autoAnalyzeBlocker,
  isEffectivelyArchived,
  isRepoArchived,
} from "../src/repo-config.js";
import { reviewRequestRefreshIdle, resetReviewRequestRefresh } from "../src/review-request-refresh.js";
import { buildFixture, key, REV2_PATCH } from "./fixtures.js";
import { fakeClaude, scriptedRun, type FakeClaude } from "./fake-claude.js";

/**
 * Repo-level archive: a flag in repo.json that makes every PR of the repo
 * behave as archived, without touching any PR's own `meta.archived`.
 */

const repo = { host: key.host, owner: key.owner, repo: key.repo };
const encodedKey = encodeURIComponent(keyToString(key));
const encodedRepo = encodeURIComponent(`${repo.host}/${repo.owner}/${repo.repo}`);
const other: PrKey = { ...key, number: 8 };

let root: string;
let app: ReturnType<typeof createApp>;
let claude: FakeClaude;

function track(k: PrKey, extra: Record<string, unknown> = {}) {
  writeMeta(
    k,
    {
      host: k.host,
      owner: k.owner,
      repo: k.repo,
      number: k.number,
      url: `https://github.com/${k.owner}/${k.repo}/pull/${k.number}`,
      createdAt: new Date().toISOString(),
      ...extra,
    },
    root,
  );
}

/** A gh that moves the fixture PR to revision 2 on refresh. */
function ghRev2(): GhRunner {
  const runner: GhRunner = (args) => {
    const joined = args.join(" ");
    if (args[1] === "graphql") {
      return JSON.stringify({ data: { repository: { pullRequest: { reviewDecision: null } } } });
    }
    if (joined.includes("v3.diff")) return REV2_PATCH;
    if (joined.includes("/compare/")) return JSON.stringify({ merge_base_commit: { sha: "mb2" } });
    if (/pulls\/\d+$/.test(args[args.length - 1] ?? "")) {
      return JSON.stringify({
        node_id: "PR_1",
        number: key.number,
        title: "Add widgets",
        html_url: "https://example.invalid/pr",
        state: "open",
        draft: false,
        merged: false,
        base: { ref: "main", sha: "base2" },
        head: { ref: "feature", sha: "head2" },
      });
    }
    return "{}";
  };
  setGhRunner(runner);
  return runner;
}

const post = (url: string, body: unknown) =>
  app.request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-repo-archive-"));
  process.env.PURVIEW_SKILL_DIR = path.join(root, "skills");
  fs.mkdirSync(process.env.PURVIEW_SKILL_DIR, { recursive: true });
  buildFixture(root);
  app = createApp({ stateDir: root, webDist: path.join(root, "__no-web-dist__"), reviewRequestRefresh: false });
  claude = fakeClaude({ lines: scriptedRun() });
  claude.install();
});

afterEach(async () => {
  await analysisIdle();
  claude.restore();
  setGhRunner(null);
  resetReviewRequestRefresh();
  delete process.env.PURVIEW_SKILL_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("repo.json archived", () => {
  it("round-trips, and an old repo.json without the field reads as not archived", () => {
    fs.writeFileSync(repoConfigPath(repo, root), JSON.stringify({ autoAnalyze: true, watchReviews: true }));
    expect(readRepoConfig(repo, root)).toMatchObject({ autoAnalyze: true, watchReviews: true, archived: null });
    expect(isRepoArchived(repo, root)).toBe(false);

    writeRepoConfig(repo, { archived: true }, root);
    expect(readRepoConfig(repo, root)).toMatchObject({ autoAnalyze: true, watchReviews: true, archived: true });
    expect(isRepoArchived(repo, root)).toBe(true);
  });
});

describe("effective archive", () => {
  it("a PR of an archived repo is effectively archived; its own flag is untouched", () => {
    expect(isEffectivelyArchived(key, root)).toBe(false);
    writeRepoConfig(repo, { archived: true }, root);
    expect(isEffectivelyArchived(key, root)).toBe(true);
    expect(archiveSource(key, root)).toBe("repo");
    expect(readMeta(key, root).archived).toBe(false);

    // The PR's own flag wins the attribution.
    updateMeta(key, { archived: true }, root);
    expect(archiveSource(key, root)).toBe("pr");
  });

  it("auto-analysis is never allowed for a PR in an archived repo", () => {
    writeRepoConfig(repo, { autoAnalyze: true }, root);
    expect(autoAnalyzeAllowed(key, root)).toBe(true);
    writeRepoConfig(repo, { archived: true }, root);
    expect(autoAnalyzeAllowed(key, root)).toBe(false);
    expect(autoAnalyzeBlocker(key, root)).toBe("archived");
    // "disabled" still wins when the layers say no anyway.
    writeRepoConfig(repo, { autoAnalyze: false }, root);
    expect(autoAnalyzeBlocker(key, root)).toBe("disabled");
  });

  it("a refresh of a PR in an archived repo skips the automatic run and records why", async () => {
    ghRev2();
    writeRepoConfig(repo, { archived: true }, root);
    const res = await app.request(`/api/prs/${encodedKey}/refresh`, { method: "POST" });
    const body = await res.json();
    expect(body.added).toBe(true);
    expect(body.analysisJob).toBeNull();
    expect(body.analysisSkipped).toBe("archived");
    expect(readMeta(key, root).analysisPending).toEqual({ revision: 2, reason: "archived" });
    expect(readMeta(key, root).archived).toBe(false);
  });

  it("prunes the managed checkouts of an archived repo's PRs", async () => {
    // A plain directory is enough: prune falls back to deleting what git
    // does not know. What matters here is that the repo flag is a reason.
    const dir = prCheckoutPath(key, root);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "file.ts"), "x");
    expect(await pruneCheckouts(root)).toEqual([]);
    writeRepoConfig(repo, { archived: true }, root);
    expect(await pruneCheckouts(root)).toEqual([dir]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("the list's background review-request lookup leaves a PR of an archived repo alone", async () => {
    let lookups = 0;
    const listing = createApp({
      stateDir: root,
      webDist: path.join(root, "__no-web-dist__"),
      reviewRequestRefresh: {
        resolve: async () => {
          lookups += 1;
          return null;
        },
      },
    });
    writeRepoConfig(repo, { archived: true }, root);
    await listing.request("/api/prs");
    await reviewRequestRefreshIdle();
    expect(lookups).toBe(0);

    writeRepoConfig(repo, { archived: null }, root);
    await listing.request("/api/prs");
    await reviewRequestRefreshIdle();
    expect(lookups).toBe(1);
  });
});

describe("POST /api/repos/:rkey/archive", () => {
  it("archives the repo without touching any PR's own flag, so unarchiving restores each exactly", async () => {
    track(other, { archived: true });
    const res = await post(`/api/repos/${encodedRepo}/archive`, { archived: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, archived: true });
    expect(readMeta(key, root).archived).toBe(false);
    expect(readMeta(other, root).archived).toBe(true);

    const list = await (await app.request("/api/prs")).json();
    const byKey = Object.fromEntries(list.prs.map((p: { key: string }) => [p.key, p]));
    expect(byKey[keyToString(key)]).toMatchObject({ archived: false, repoArchived: true });
    expect(byKey[keyToString(other)]).toMatchObject({ archived: true, repoArchived: true });
    const repos = await (await app.request("/api/repos")).json();
    expect(repos.repos[0]).toMatchObject({ archived: true, archivedCount: 1, hasLocalConfig: false });
    const detail = await (await app.request(`/api/prs/${encodedKey}`)).json();
    expect(detail.repoArchived).toBe(true);
    expect(detail.meta.archived).toBe(false);

    const back = await post(`/api/repos/${encodedRepo}/archive`, { archived: false });
    expect(await back.json()).toEqual({ ok: true, archived: false });
    expect(readRepoConfig(repo, root).archived).toBeNull();
    const after = await (await app.request("/api/prs")).json();
    const afterByKey = Object.fromEntries(after.prs.map((p: { key: string }) => [p.key, p]));
    expect(afterByKey[keyToString(key)]).toMatchObject({ archived: false, repoArchived: false });
    expect(afterByKey[keyToString(other)]).toMatchObject({ archived: true, repoArchived: false });
  });

  it("400s on a non-boolean and 404s on an untracked repo", async () => {
    expect((await post(`/api/repos/${encodedRepo}/archive`, { archived: "yes" })).status).toBe(400);
    const missing = await post(`/api/repos/${encodeURIComponent("github.com/acme/nope")}/archive`, {
      archived: true,
    });
    expect(missing.status).toBe(404);
    expect(fs.existsSync(path.join(root, "github.com", "acme", "nope"))).toBe(false);
  });

  it("is refused to the review chat", async () => {
    const res = await app.request(`/api/repos/${encodedRepo}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Purview-Actor": "chat" },
      body: JSON.stringify({ archived: true }),
    });
    expect(res.status).toBe(403);
    expect(isRepoArchived(repo, root)).toBe(false);
  });
});
