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
import {
  findImportCandidates,
  importReviewRequests,
  importReviewRequestsSince,
  importSelectedPrs,
  mergeImportResults,
} from "../src/review-import.js";
import { readMeta } from "@reviewer/core";
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
  /** what `--search author:` returns (your own PRs); default: nothing */
  own?: Candidate[];
  /** issue-timeline events per PR, for the review-request lookup */
  timeline?: Record<number, object[]>;
}): GhRunner & { searchCalls: string[][] } {
  const searchCalls: string[][] = [];
  const runner = ((args: string[]) => {
    const joined = args.join(" ");
    if (args[0] === "pr" && args[1] === "list") {
      searchCalls.push([...args]);
      if (joined.includes("author:")) return JSON.stringify(opts.own ?? []);
      return JSON.stringify(opts.candidates);
    }
    if (args[0] === "api" && args[args.length - 1] === "user") return JSON.stringify({ login: "me" });
    if (joined.includes("user/teams")) return "";
    const timeline = /issues\/(\d+)\/timeline/.exec(joined);
    if (timeline) return (opts.timeline?.[Number(timeline[1])] ?? []).map((e) => JSON.stringify(e)).join("\n");
    if (args[1] === "graphql") {
      return JSON.stringify({ data: { repository: { pullRequest: { reviewDecision: null } } } });
    }
    if (joined.includes("v3.diff")) return "";
    if (joined.includes("/compare/")) {
      return JSON.stringify({ merge_base_commit: { sha: "mb1" } });
    }
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
  it("imports every untracked review-requested PR and skips already-tracked ones", async () => {
    ghFor({ candidates: [{ number: 1, title: "One", updatedAt: "2024-01-01T00:00:00Z" }, { number: 2, title: "Two", updatedAt: "2024-01-02T00:00:00Z" }] });
    // PR 1 is already tracked before the import runs.
    initPr({ ...repo, number: 1 }, root);

    const result = await importReviewRequestsSince(repo, new Date(0), root, { analyze: false });

    expect(result.alreadyTracked).toEqual([keyToString({ ...repo, number: 1 })]);
    expect(result.imported).toEqual([keyToString({ ...repo, number: 2 })]);
    expect(result.failed).toEqual([]);
  });

  it("treats an archived PR as tracked, never resurrecting it", async () => {
    ghFor({ candidates: [{ number: 5, title: "Archived one", updatedAt: "2024-01-01T00:00:00Z" }] });
    initPr({ ...repo, number: 5 }, root);
    // Archive it out of the active list.
    updateMeta({ ...repo, number: 5 }, { archived: true }, root);

    const result = await importReviewRequestsSince(repo, new Date(0), root, { analyze: false });

    expect(result.alreadyTracked).toEqual([keyToString({ ...repo, number: 5 })]);
    expect(result.imported).toEqual([]);
  });

  it("isolates one PR's failure from the rest of the batch", async () => {
    ghFor({
      candidates: [
        { number: 10, title: "Good", updatedAt: "2024-01-01T00:00:00Z" },
        { number: 11, title: "Bad", updatedAt: "2024-01-01T00:00:00Z" },
        { number: 12, title: "Also good", updatedAt: "2024-01-01T00:00:00Z" },
      ],
      failNumbers: [11],
    });

    const result = await importReviewRequestsSince(repo, new Date(0), root, { analyze: false });

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

    const result = await importReviewRequestsSince(repo, new Date(0), root, { analyze: true });

    expect(result.imported).toEqual([
      keyToString({ ...repo, number: 20 }),
      keyToString({ ...repo, number: 20 }),
    ]);
    expect(result.failed).toEqual([]);

    // The hanging run never finishes on its own; cancel it so afterEach's
    // analysisIdle() does not hang the test suite.
    cancelAnalysis({ ...repo, number: 20 }, root);
  });

  it("days -> since math: importReviewRequests searches from now - days*24h", async () => {
    const gh = ghFor({ candidates: [] });
    const before = Date.now();
    await importReviewRequests(repo, 3, root, { analyze: false });
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

describe("an archived PR asked for your review again", () => {
  const key = { ...repo, number: 7 };
  const requested = (at: string) => ({
    event: "review_requested",
    created_at: at,
    requested_reviewer: { login: "me" },
    review_requester: { login: "dana" },
  });

  it("comes back when the request is newer than the archiving", async () => {
    ghFor({ candidates: [{ number: 7, title: "Seven", updatedAt: "2026-01-02T00:00:00Z" }], timeline: { 7: [requested("2026-01-02T10:00:00Z")] } });
    initPr(key, root);
    updateMeta(key, { archived: true, archivedAt: "2026-01-01T00:00:00.000Z", reviewRequestCheckedAt: undefined }, root);

    const result = await importReviewRequestsSince(repo, new Date(0), root, { analyze: false });

    expect(result.unarchived).toEqual([keyToString(key)]);
    expect(readMeta(key, root).archived).toBe(false);
    expect(readMeta(key, root).archivedAt).toBeUndefined();
    expect(readMeta(key, root).reviewRequest?.at).toBe("2026-01-02T10:00:00Z");
  });

  it("stays archived when you archived it with that request already pending", async () => {
    ghFor({ candidates: [{ number: 7, title: "Seven", updatedAt: "2026-01-03T00:00:00Z" }], timeline: { 7: [requested("2026-01-02T10:00:00Z")] } });
    initPr(key, root);
    updateMeta(key, { archived: true, archivedAt: "2026-01-03T00:00:00.000Z", reviewRequestCheckedAt: undefined }, root);

    const result = await importReviewRequestsSince(repo, new Date(0), root, { analyze: false });

    expect(result.unarchived).toEqual([]);
    expect(readMeta(key, root).archived).toBe(true);
  });

  it("archiving stamps when, so a PR archived without the stamp is never brought back by an old request", async () => {
    ghFor({ candidates: [] });
    initPr(key, root);
    const before = Date.now();
    updateMeta(key, { archived: true }, root);
    expect(Date.parse(readMeta(key, root).archivedAt ?? "")).toBeGreaterThanOrEqual(before);
    updateMeta(key, { archived: false }, root);
    expect(readMeta(key, root).archivedAt).toBeUndefined();
  });
});

describe("findImportCandidates", () => {
  it("merges both searches by number, marking the source and what is tracked or archived", async () => {
    ghFor({
      candidates: [
        { number: 1, title: "Asked", updatedAt: "2026-01-01T00:00:00Z" },
        { number: 3, title: "Both", updatedAt: "2026-01-03T00:00:00Z" },
      ],
      own: [
        { number: 2, title: "Mine", updatedAt: "2026-01-02T00:00:00Z" },
        { number: 3, title: "Both", updatedAt: "2026-01-03T00:00:00Z" },
      ],
    });
    initPr({ ...repo, number: 1 }, root);
    initPr({ ...repo, number: 2 }, root);
    updateMeta({ ...repo, number: 2 }, { archived: true }, root);

    const found = await findImportCandidates(repo, 7, ["requests", "own"], root);

    expect(found.map((c) => [c.number, c.sources, c.tracked, c.archived])).toEqual([
      [3, ["requests", "own"], false, false],
      [2, ["own"], true, true],
      [1, ["requests"], true, false],
    ]);
  });

  it("runs only the searches asked for", async () => {
    const gh = ghFor({ candidates: [], own: [{ number: 2, title: "Mine", updatedAt: "2026-01-02T00:00:00Z" }] });
    const found = await findImportCandidates(repo, 7, ["own"], root);
    expect(found.map((c) => c.number)).toEqual([2]);
    expect(gh.searchCalls.some((a) => a.join(" ").includes("review-requested"))).toBe(false);
  });
});

describe("importSelectedPrs", () => {
  it("imports exactly the picked PRs and brings a picked archived one back", async () => {
    ghFor({ candidates: [] });
    initPr({ ...repo, number: 4 }, root);
    updateMeta({ ...repo, number: 4 }, { archived: true }, root);

    const result = await importSelectedPrs(repo, [4, 8, 8], root, { analyze: false });

    expect(result.imported).toEqual([keyToString({ ...repo, number: 8 })]);
    expect(result.unarchived).toEqual([keyToString({ ...repo, number: 4 })]);
    expect(readMeta({ ...repo, number: 4 }, root).archived).toBe(false);
  });
});

describe("mergeImportResults", () => {
  it("does not call a PR the first search imported 'already tracked' by the second", () => {
    const base = { failed: [], sharedImports: [], unarchived: [] };
    const merged = mergeImportResults(
      { ...base, imported: ["a"], alreadyTracked: ["b"] },
      { ...base, imported: [], alreadyTracked: ["a", "b"] },
    );
    expect(merged.imported).toEqual(["a"]);
    expect(merged.alreadyTracked).toEqual(["b"]);
  });
});
