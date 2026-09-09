import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  initPr,
  keyToString,
  setGhRunner,
  updateMeta,
  type GhRunner,
  type RepoKey,
} from "@reviewer/core";
import { importReviewRequests, importReviewRequestsSince } from "../src/review-import.js";
import { analysisIdle, cancelAnalysis } from "../src/analysis.js";
import { fakeClaude, type FakeClaude } from "./fake-claude.js";

const repo: RepoKey = { host: "github.com", owner: "acme", repo: "widgets" };

let root: string;
let claude: FakeClaude;

interface Candidate {
  number: number;
  title: string;
  updatedAt: string;
}

/**
 * `gh` covering `gh pr list --search` plus everything `initPr`/refresh touch
 * for each candidate: pull info, merge-base compare, the diff, and the
 * review-decision graphql query.
 */
function ghFor(opts: {
  candidates: Candidate[];
  /** PR numbers whose `initPr` should throw, simulating a fetch failure. */
  failNumbers?: number[];
}): GhRunner & { searchCalls: string[][] } {
  const searchCalls: string[][] = [];
  const runner = ((args: string[]) => {
    const joined = args.join(" ");
    if (args[0] === "pr" && args[1] === "list") {
      searchCalls.push([...args]);
      return JSON.stringify(opts.candidates);
    }
    if (args[1] === "graphql") {
      return JSON.stringify({ data: { repository: { pullRequest: { reviewDecision: null } } } });
    }
    if (joined.includes("/compare/")) {
      return JSON.stringify({ merge_base_commit: { sha: "mb1" } });
    }
    if (joined.includes("v3.diff")) return "";
    const pullMatch = /pulls\/(\d+)$/.exec(args[args.length - 1] ?? "");
    if (pullMatch) {
      const number = Number(pullMatch[1]);
      if (opts.failNumbers?.includes(number)) {
        throw new Error(`gh api repos/acme/widgets/pulls/${number} failed: HTTP 500`);
      }
      const candidate = opts.candidates.find((c) => c.number === number);
      return JSON.stringify({
        node_id: `PR_${number}`,
        number,
        title: candidate?.title ?? `PR ${number}`,
        html_url: `https://github.com/acme/widgets/pull/${number}`,
        state: "open",
        draft: false,
        merged: false,
        base: { ref: "main", sha: "base1" },
        head: { ref: `feature-${number}`, sha: `head${number}` },
      });
    }
    return "{}";
  }) as GhRunner & { searchCalls: string[][] };
  runner.searchCalls = searchCalls;
  setGhRunner(runner);
  return runner;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-review-import-"));
  process.env.PURVIEW_SKILL_DIR = path.join(root, "skills");
  process.env.PURVIEW_CLI_PATH = path.join(root, "cli.js");
  fs.mkdirSync(process.env.PURVIEW_SKILL_DIR, { recursive: true });
  claude = fakeClaude();
  claude.install();
});

afterEach(async () => {
  await analysisIdle();
  claude.restore();
  setGhRunner(null);
  delete process.env.PURVIEW_SKILL_DIR;
  delete process.env.PURVIEW_CLI_PATH;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("importReviewRequestsSince", () => {
  it("imports every untracked review-requested PR and skips already-tracked ones", () => {
    ghFor({ candidates: [{ number: 1, title: "One", updatedAt: "2024-01-01T00:00:00Z" }, { number: 2, title: "Two", updatedAt: "2024-01-02T00:00:00Z" }] });
    // PR 1 is already tracked before the import runs.
    initPr({ ...repo, number: 1 }, root);

    const result = importReviewRequestsSince(repo, new Date(0), root, { analyze: false });

    expect(result.alreadyTracked).toEqual([keyToString({ ...repo, number: 1 })]);
    expect(result.imported).toEqual([keyToString({ ...repo, number: 2 })]);
    expect(result.failed).toEqual([]);
  });

  it("treats an archived PR as tracked, never resurrecting it", () => {
    ghFor({ candidates: [{ number: 5, title: "Archived one", updatedAt: "2024-01-01T00:00:00Z" }] });
    initPr({ ...repo, number: 5 }, root);
    // Archive it out of the active list.
    updateMeta({ ...repo, number: 5 }, { archived: true }, root);

    const result = importReviewRequestsSince(repo, new Date(0), root, { analyze: false });

    expect(result.alreadyTracked).toEqual([keyToString({ ...repo, number: 5 })]);
    expect(result.imported).toEqual([]);
  });

  it("isolates one PR's failure from the rest of the batch", () => {
    ghFor({
      candidates: [
        { number: 10, title: "Good", updatedAt: "2024-01-01T00:00:00Z" },
        { number: 11, title: "Bad", updatedAt: "2024-01-01T00:00:00Z" },
        { number: 12, title: "Also good", updatedAt: "2024-01-01T00:00:00Z" },
      ],
      failNumbers: [11],
    });

    const result = importReviewRequestsSince(repo, new Date(0), root, { analyze: false });

    expect(result.imported.sort()).toEqual(
      [keyToString({ ...repo, number: 10 }), keyToString({ ...repo, number: 12 })].sort(),
    );
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].key).toBe(keyToString({ ...repo, number: 11 }));
    expect(result.failed[0].error).toContain("HTTP 500");
  });

  it("counts a 409 from an already-queued analysis as imported, not failed", async () => {
    // A duplicate entry in the search results (gh's own quirk, or a paging
    // artifact) means the same untracked PR is processed twice in one batch:
    // `tracked` is snapshotted once at the start, so the second pass still
    // sees it as new, calls `initPr` again (idempotent) and `startAnalysis`
    // again — which now 409s because the first pass's job is still queued
    // (nothing has pumped it yet; the queue drains on a microtask). That 409
    // must land in `imported`, not `failed`.
    ghFor({
      candidates: [
        { number: 20, title: "Queued twice", updatedAt: "2024-01-01T00:00:00Z" },
        { number: 20, title: "Queued twice", updatedAt: "2024-01-01T00:00:00Z" },
      ],
    });
    claude = fakeClaude({ hang: true });
    claude.install();

    const result = importReviewRequestsSince(repo, new Date(0), root, { analyze: true });

    expect(result.imported).toEqual([
      keyToString({ ...repo, number: 20 }),
      keyToString({ ...repo, number: 20 }),
    ]);
    expect(result.failed).toEqual([]);

    // The hanging run never finishes on its own; cancel it so afterEach's
    // analysisIdle() does not hang the test suite.
    cancelAnalysis({ ...repo, number: 20 }, root);
  });

  it("days -> since math: importReviewRequests searches from now - days*24h", () => {
    const gh = ghFor({ candidates: [] });
    const before = Date.now();
    importReviewRequests(repo, 3, root, { analyze: false });
    const after = Date.now();

    expect(gh.searchCalls).toHaveLength(1);
    const searchArg = gh.searchCalls[0].find((a) => a.startsWith("review-requested"));
    const dateMatch = /updated:>=(\d{4}-\d{2}-\d{2})/.exec(searchArg ?? "");
    expect(dateMatch).toBeTruthy();
    const sentDay = dateMatch![1];
    const expectedEarliest = new Date(before - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const expectedLatest = new Date(after - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    // Either day is fine — the test runs in well under a day, but this avoids
    // flaking across a UTC midnight boundary.
    expect([expectedEarliest, expectedLatest]).toContain(sentDay);
  });
});
