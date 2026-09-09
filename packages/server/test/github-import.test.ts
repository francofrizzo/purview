import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadState, prDir, setHunkViewed, listPrs, readMeta, setGhRunner, updateMeta, writeRepoConfig } from "@reviewer/core";
import { createApp } from "../src/app.js";
import { discoverPullRequests } from "../src/github-import.js";
import { buildFixture, key, REV1_PATCH } from "./fixtures.js";

vi.mock("../src/analysis.js", async (original) => ({
  ...await original<typeof import("../src/analysis.js")>(),
  startAnalysis: vi.fn(() => ({ status: "queued" })),
}));
import { startAnalysis } from "../src/analysis.js";

let root: string;
const url = (n: number) => `https://github.com/acme/widgets/pull/${n}`;
const page = (numbers: number[], total = numbers.length, incomplete = false) => JSON.stringify({
  total_count: total, incomplete_results: incomplete,
  items: numbers.map((n) => ({ html_url: url(n), created_at: new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString() })),
});

function install(search: (args: string[]) => string, failPr?: number) {
  const calls: string[][] = [];
  setGhRunner((args) => {
    calls.push(args);
    if (args.includes("user")) return JSON.stringify({ login: "octocat" });
    if (args.includes("search/issues")) return search(args);
    const endpoint = args.find((a) => /^repos\//.test(a)) ?? "";
    if (failPr && endpoint.endsWith(`/pulls/${failPr}`)) throw new Error("gh api failed: inaccessible PR");
    if (args.includes("Accept: application/vnd.github.v3.diff")) return REV1_PATCH;
    if (endpoint.includes("/compare/")) return JSON.stringify({ merge_base_commit: { sha: "mb" } });
    const match = endpoint.match(/\/pulls\/(\d+)$/);
    if (match) return JSON.stringify({
      node_id: `PR_${match[1]}`, number: Number(match[1]), title: "Imported PR", html_url: url(Number(match[1])),
      state: "open", base: { ref: "main", sha: "base" }, head: { ref: "feature", sha: "head" },
    });
    return "{}";
  });
  return calls;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-import-"));
  vi.mocked(startAnalysis).mockClear();
});
afterEach(() => {
  setGhRunner(null);
  fs.rmSync(root, { recursive: true, force: true });
});

const request = (app: ReturnType<typeof createApp>, scope = "all", suffix = "") => app.request(`/api/prs/import${suffix}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope }),
});

describe("GitHub discovery", () => {
  it("uses all three open scopes, pins github.com, deduplicates and paginates", () => {
    const calls = install((args) => {
      if (args.includes("q=is:pr is:open author:octocat")) {
        return args.includes("page=1") ? page(Array.from({ length: 100 }, (_, i) => i + 1), 101) : page([101], 101);
      }
      return page([1]);
    });
    const result = discoverPullRequests("all");
    expect(result.urls).toHaveLength(101);
    expect(result.warnings).toEqual([]);
    const searches = calls.filter((args) => args.includes("search/issues"));
    expect(searches).toHaveLength(4);
    expect(searches.flat()).toContain("q=is:pr is:open assignee:octocat");
    expect(searches.flat()).toContain("q=is:pr is:open review-requested:octocat");
    for (const args of calls) expect(args.slice(0, 3)).toEqual(["api", "--hostname", "github.com"]);
  });

  it("sorts the union of scopes by creation time, independent of PR number", () => {
    install((args) => {
      const items = args.includes("q=is:pr is:open author:octocat")
        ? [{ html_url: url(7), created_at: "2026-09-03T00:00:00Z" }]
        : args.includes("q=is:pr is:open assignee:octocat")
          ? [{ html_url: url(9), created_at: "2026-09-01T00:00:00Z" }]
          : [{ html_url: url(8), created_at: "2026-09-02T00:00:00Z" }, { html_url: url(7), created_at: "2026-09-03T00:00:00Z" }];
      return JSON.stringify({ items, total_count: items.length, incomplete_results: false });
    });
    expect(discoverPullRequests("all").urls).toEqual([url(9), url(8), url(7)]);
  });

  it("reports incomplete results and GitHub's search ceiling", () => {
    install(() => page([1], 1001, true));
    expect(discoverPullRequests("created").warnings).toHaveLength(2);
  });
});

describe("POST /api/prs/import", () => {
  it("defaults to review requests without importing authored or assigned PRs", async () => {
    const calls = install((args) => page(args.includes("q=is:pr is:open review-requested:octocat") ? [8] : [9]));
    const response = await createApp({ stateDir: root }).request("/api/prs/import", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ added: ["github.com/acme/widgets/8"], queued: 1 });
    expect(calls.filter((args) => args.includes("search/issues"))).toHaveLength(1);
    expect(startAnalysis).toHaveBeenCalledTimes(1);
  });

  it("restores archived matches once, preserves review work, and skips active matches", async () => {
    buildFixture(root);
    updateMeta(key, { archived: true }, root);
    const hunkId = Object.keys(loadState(key, root).hunks)[0];
    setHunkViewed(key, hunkId, true, root);
    const commentsFile = path.join(prDir(key, root), "comments.json");
    const comments = JSON.stringify([{ id: "keep", body: "Keep feedback" }]);
    fs.writeFileSync(commentsFile, comments);
    install(() => page([7, 8, 8]));
    const app = createApp({ stateDir: root });
    const first = await request(app);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ added: ["github.com/acme/widgets/7", "github.com/acme/widgets/8"], skipped: [], queued: 2, failed: [] });
    expect(startAnalysis).toHaveBeenCalledTimes(2);
    expect(readMeta(key, root).archived).toBe(false);
    expect(loadState(key, root).hunks[hunkId].viewed).toBe(true);
    expect(fs.readFileSync(commentsFile, "utf8")).toBe(comments);
    expect((await (await request(app)).json()).added).toEqual([]);
    expect(startAnalysis).toHaveBeenCalledTimes(2);
    expect(listPrs(root)).toHaveLength(2);
  });

  it("queues archived and new PRs together from oldest creation date to newest", async () => {
    buildFixture(root);
    updateMeta(key, { archived: true }, root);
    install(() => JSON.stringify({
      total_count: 3, incomplete_results: false,
      items: [
        { html_url: url(7), created_at: "2026-09-03T00:00:00Z" },
        { html_url: url(8), created_at: "2026-09-02T00:00:00Z" },
        { html_url: url(9), created_at: "2026-09-01T00:00:00Z" },
      ],
    }));
    const response = await request(createApp({ stateDir: root }), "review-requested");
    expect(response.status).toBe(200);
    expect((await response.json()).queued).toBe(3);
    expect(vi.mocked(startAnalysis).mock.calls.map(([key]) => key.number)).toEqual([9, 8, 7]);
  });

  it.each(["process", "repo", "request"])("respects the %s analysis opt-out", async (setting) => {
    install(() => page([8]));
    if (setting === "repo") writeRepoConfig(key, { autoAnalyze: false }, root);
    const app = createApp({ stateDir: root, autoAnalyze: setting !== "process" });
    const result = await (await request(app, "created", setting === "request" ? "?analyze=false" : "")).json();
    expect(result.added).toHaveLength(1);
    expect(result.queued).toBe(0);
    expect(startAnalysis).not.toHaveBeenCalled();
  });

  it.each(["process", "repo", "request"])("restores archived PRs while respecting the %s analysis opt-out", async (setting) => {
    buildFixture(root);
    updateMeta(key, { archived: true }, root);
    install(() => page([7]));
    if (setting === "repo") writeRepoConfig(key, { autoAnalyze: false }, root);
    const app = createApp({ stateDir: root, autoAnalyze: setting !== "process" });
    const result = await (await request(app, "review-requested", setting === "request" ? "?analyze=false" : "")).json();
    expect(result).toMatchObject({ added: ["github.com/acme/widgets/7"], queued: 0, failed: [] });
    expect(readMeta(key, root).archived).toBe(false);
    expect(startAnalysis).not.toHaveBeenCalled();
  });

  it("leaves archived PRs archived if refresh fails and retries them on the next import", async () => {
    buildFixture(root);
    updateMeta(key, { archived: true }, root);
    const before = loadState(key, root);
    install(() => page([7]), 7);
    const app = createApp({ stateDir: root });
    const result = await (await request(app)).json();
    expect(result.failed).toHaveLength(1);
    expect(result.added).toEqual([]);
    expect(readMeta(key, root).archived).toBe(true);
    expect(loadState(key, root)).toEqual(before);
    expect(startAnalysis).not.toHaveBeenCalled();
    install(() => page([7]));
    expect((await (await request(app)).json()).added).toEqual(["github.com/acme/widgets/7"]);
    expect(readMeta(key, root).archived).toBe(false);
    expect(startAnalysis).toHaveBeenCalledTimes(1);
  });

  it("continues after an individual PR fails and allows retrying it", async () => {
    install(() => page([8, 9]), 8);
    const app = createApp({ stateDir: root, autoAnalyze: false });
    const result = await (await request(app)).json();
    expect(result.added).toEqual(["github.com/acme/widgets/9"]);
    expect(result.failed).toEqual([{ url: url(8), error: "gh api failed: inaccessible PR" }]);
    install(() => page([8, 9]));
    expect((await (await request(app)).json()).added).toEqual(["github.com/acme/widgets/8"]);
  });

  it("retries an import that failed after writing metadata", async () => {
    const app = createApp({ stateDir: root });
    // Simulate a diff failure after init has already persisted the PR metadata.
    let failDiff = true;
    setGhRunner((args) => {
      if (args.includes("user")) return JSON.stringify({ login: "octocat" });
      if (args.includes("search/issues")) return page([8]);
      if (args.includes("Accept: application/vnd.github.v3.diff")) {
        if (failDiff) throw new Error("gh api failed: diff unavailable");
        return REV1_PATCH;
      }
      if (args.some((a) => a.includes("/compare/"))) return JSON.stringify({ merge_base_commit: { sha: "mb" } });
      if (args.some((a) => a.endsWith("/pulls/8"))) return JSON.stringify({
        node_id: "PR_8", number: 8, title: "PR", html_url: url(8), state: "open",
        base: { ref: "main", sha: "base" }, head: { ref: "feature", sha: "head" },
      });
      return "{}";
    });
    expect((await (await request(app)).json()).failed).toHaveLength(1);
    failDiff = false;
    const retry = await (await request(app)).json();
    expect(retry.added).toEqual(["github.com/acme/widgets/8"]);
    expect(retry.queued).toBe(1);
  });

  it("handles no matches", async () => {
    install(() => page([]));
    const result = await (await request(createApp({ stateDir: root }))).json();
    expect(result).toMatchObject({ added: [], skipped: [], failed: [], queued: 0 });
  });

  it("rejects invalid scopes before calling GitHub", async () => {
    const calls = install(() => page([]));
    const response = await request(createApp({ stateDir: root }), "invalid");
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("does not import anything when discovery fails", async () => {
    install((args) => {
      if (args.includes("q=is:pr is:open assignee:octocat")) throw new Error("gh api failed: HTTP 403 rate limit");
      return page([8]);
    });
    const response = await request(createApp({ stateDir: root }));
    expect(response.status).toBe(502);
    expect(listPrs(root)).toEqual([]);
  });

  it("rejects cross-origin imports", async () => {
    const calls = install(() => page([8]));
    const response = await createApp({ stateDir: root }).request("/api/prs/import", {
      method: "POST", headers: { Origin: "https://example.com" },
    });
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });
});
