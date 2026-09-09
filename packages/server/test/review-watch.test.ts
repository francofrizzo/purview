import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initPr, setGhRunner, writeRepoConfig, type GhRunner, type RepoKey } from "@reviewer/core";
import { getWatchStatus, resetWatchStatus, startReviewWatch, type ReviewWatch } from "../src/review-watch.js";
import { analysisIdle } from "../src/analysis.js";
import { fakeClaude, type FakeClaude } from "./fake-claude.js";

const repoA: RepoKey = { host: "github.com", owner: "acme", repo: "widgets" };
const repoB: RepoKey = { host: "github.com", owner: "acme", repo: "gadgets" };

let root: string;
let claude: FakeClaude;
let watch: ReviewWatch | undefined;

/** `gh` covering `pr list --search` (per-repo candidate lists) plus init/refresh. */
function ghFor(candidatesByRepo: Record<string, { number: number; title: string; updatedAt: string }[]>): GhRunner {
  return (args: string[]) => {
    const joined = args.join(" ");
    if (args[0] === "pr" && args[1] === "list") {
      const rIdx = args.indexOf("-R");
      const repoArg = args[rIdx + 1];
      return JSON.stringify(candidatesByRepo[repoArg] ?? []);
    }
    if (args[1] === "graphql") {
      return JSON.stringify({ data: { repository: { pullRequest: { reviewDecision: null } } } });
    }
    if (joined.includes("/compare/")) return JSON.stringify({ merge_base_commit: { sha: "mb1" } });
    if (joined.includes("v3.diff")) return "";
    const pullMatch = /pulls\/(\d+)$/.exec(args[args.length - 1] ?? "");
    if (pullMatch) {
      const number = Number(pullMatch[1]);
      return JSON.stringify({
        node_id: `PR_${number}`,
        number,
        title: `PR ${number}`,
        html_url: `https://github.com/x/y/pull/${number}`,
        state: "open",
        draft: false,
        merged: false,
        base: { ref: "main", sha: "base1" },
        head: { ref: `feature-${number}`, sha: `head${number}` },
      });
    }
    return "{}";
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-review-watch-"));
  process.env.PURVIEW_SKILL_DIR = path.join(root, "skills");
  process.env.PURVIEW_CLI_PATH = path.join(root, "cli.js");
  fs.mkdirSync(process.env.PURVIEW_SKILL_DIR, { recursive: true });
  claude = fakeClaude();
  claude.install();
  resetWatchStatus();
});

afterEach(async () => {
  watch?.stop();
  watch = undefined;
  await analysisIdle();
  claude.restore();
  setGhRunner(null);
  delete process.env.PURVIEW_SKILL_DIR;
  delete process.env.PURVIEW_CLI_PATH;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("startReviewWatch", () => {
  it("only searches repos with watchReviews on, and skips the rest", async () => {
    const gh = ghFor({
      "acme/widgets": [{ number: 1, title: "One", updatedAt: "2024-01-01T00:00:00Z" }],
      "acme/gadgets": [{ number: 2, title: "Two", updatedAt: "2024-01-01T00:00:00Z" }],
    });
    const calls: string[][] = [];
    setGhRunner((args) => {
      calls.push([...args]);
      return gh(args);
    });

    // Both repos need to exist on disk to be discovered by listRepos(); an
    // empty repo.json (ensureRepoConfig-style) is enough for one of them.
    writeRepoConfig(repoA, { watchReviews: true }, root);
    writeRepoConfig(repoB, {}, root); // present, but not opted in

    watch = startReviewWatch(root, { now: () => new Date("2024-01-05T00:00:00Z") });
    await watch.tick();

    const searchedRepos = calls
      .filter((c) => c[0] === "pr" && c[1] === "list")
      .map((c) => c[c.indexOf("-R") + 1]);
    expect(searchedRepos).toEqual(["acme/widgets"]);

    const status = getWatchStatus();
    expect(status.lastTickAt).toBe("2024-01-05T00:00:00.000Z");
    expect(status.repos["github.com/acme/widgets"]).toMatchObject({ imported: 1 });
    expect(status.repos["github.com/acme/gadgets"]).toBeUndefined();
  });

  it("re-reads config every tick, so toggling watchReviews changes behavior without a restart", async () => {
    const gh = ghFor({
      "acme/widgets": [{ number: 3, title: "Three", updatedAt: "2024-01-01T00:00:00Z" }],
    });
    const calls: string[][] = [];
    setGhRunner((args) => {
      calls.push([...args]);
      return gh(args);
    });
    writeRepoConfig(repoA, { watchReviews: false }, root);

    watch = startReviewWatch(root, { now: () => new Date("2024-01-05T00:00:00Z") });
    await watch.tick();
    expect(calls.filter((c) => c[0] === "pr" && c[1] === "list")).toHaveLength(0);

    writeRepoConfig(repoA, { watchReviews: true }, root);
    await watch.tick();
    expect(calls.filter((c) => c[0] === "pr" && c[1] === "list")).toHaveLength(1);
    expect(getWatchStatus().repos["github.com/acme/widgets"]).toMatchObject({ imported: 1 });
  });

  it("never lets one repo's gh failure stop the loop or crash the tick", async () => {
    writeRepoConfig(repoA, { watchReviews: true }, root);
    writeRepoConfig(repoB, { watchReviews: true }, root);
    setGhRunner((args) => {
      if (args[0] === "pr" && args[1] === "list" && args.includes("acme/widgets")) {
        throw new Error("gh pr list failed: HTTP 500");
      }
      return ghFor({ "acme/gadgets": [{ number: 4, title: "Four", updatedAt: "2024-01-01T00:00:00Z" }] })(
        args,
      );
    });

    watch = startReviewWatch(root, { now: () => new Date("2024-01-05T00:00:00Z") });
    await expect(watch.tick()).resolves.not.toThrow();

    const status = getWatchStatus();
    expect(status.repos["github.com/acme/widgets"]?.error).toContain("HTTP 500");
    expect(status.repos["github.com/acme/gadgets"]).toMatchObject({ imported: 1 });
  });

  it("skips tracked/archived PRs the same way a manual import would", async () => {
    setGhRunner(
      ghFor({ "acme/widgets": [{ number: 6, title: "Six", updatedAt: "2024-01-01T00:00:00Z" }] }),
    );
    initPr({ ...repoA, number: 6 }, root);
    writeRepoConfig(repoA, { watchReviews: true }, root);

    watch = startReviewWatch(root, { now: () => new Date("2024-01-05T00:00:00Z") });
    await watch.tick();

    expect(getWatchStatus().repos["github.com/acme/widgets"]).toMatchObject({ imported: 0 });
  });
});
