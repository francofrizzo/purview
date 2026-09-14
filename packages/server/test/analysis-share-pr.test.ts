import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  keyToString,
  loadState,
  parseDiff,
  renderAnalysisComment,
  setGhRunner,
  type AnalysisExport,
  type GhRunner,
} from "@reviewer/core";
import { createApp } from "../src/app.js";
import { analysisIdle } from "../src/analysis.js";
import { importReviewRequestsSince } from "../src/review-import.js";
import { buildFixture, key, REV1_PATCH } from "./fixtures.js";
import { fakeClaude, scriptedRun, type FakeClaude } from "./fake-claude.js";

const encodedKey = encodeURIComponent(keyToString(key));

let root: string;
let app: ReturnType<typeof createApp>;
let claude: FakeClaude;

interface FakeIssueComment {
  id: number;
  body: string;
  html_url: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
}

/**
 * `gh` covering everything the PR-comment analysis-sharing channel touches:
 * issue comments (list/post/patch), plus (for the init-path tests) the bare
 * minimum `initPr`/`refresh` need — PR meta, merge base, diff, review
 * decision. `sha` picks the PR's headSha, matching `AnalysisExport.headSha`
 * so a test can control whether the auto-detection sees a match.
 */
function ghWithComments(
  opts: { patch?: string; sha?: string; seedComments?: FakeIssueComment[] } = {},
): GhRunner & { comments: FakeIssueComment[] } {
  const sha = opts.sha ?? "1";
  const comments: FakeIssueComment[] = opts.seedComments ? [...opts.seedComments] : [];
  let nextId = 9000;

  const runner = ((args: string[], input?: string) => {
    const joined = args.join(" ");
    if (joined.includes("/compare/")) {
      return JSON.stringify({ merge_base_commit: { sha: `mb${sha}` } });
    }
    if (joined.includes("v3.diff")) {
      return opts.patch ?? "";
    }
    if (/pulls\/\d+$/.test(args[args.length - 1] ?? "")) {
      return JSON.stringify({
        node_id: "PR_1",
        number: key.number,
        title: "Add widgets",
        html_url: `https://github.com/${key.owner}/${key.repo}/pull/${key.number}`,
        state: "open",
        base: { ref: "main", sha: `base${sha}` },
        head: { ref: "feature", sha: `head${sha}` },
      });
    }

    const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
    const endpoint = args.find((a) => a.startsWith("repos/")) ?? "";

    if (method === "GET" && /\/issues\/\d+\/comments$/.test(endpoint)) {
      return JSON.stringify(comments);
    }
    if (method === "POST" && /\/issues\/\d+\/comments$/.test(endpoint)) {
      const body = (JSON.parse(input ?? "{}") as { body: string }).body;
      const id = nextId++;
      const c: FakeIssueComment = {
        id,
        body,
        html_url: `https://github.com/${key.owner}/${key.repo}/pull/${key.number}#issuecomment-${id}`,
        user: { login: "me" },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      comments.push(c);
      return JSON.stringify(c);
    }
    const patchMatch = endpoint.match(/\/issues\/comments\/(\d+)$/);
    if (method === "PATCH" && patchMatch) {
      const c = comments.find((cm) => cm.id === Number(patchMatch[1]));
      if (!c) throw new Error(`gh ${joined} failed: HTTP 404 Not Found`);
      c.body = (JSON.parse(input ?? "{}") as { body: string }).body;
      c.updated_at = new Date().toISOString();
      return JSON.stringify(c);
    }
    if (args[1] === "graphql") {
      return JSON.stringify({ data: { repository: { pullRequest: { reviewDecision: null } } } });
    }
    return "{}";
  }) as GhRunner & { comments: FakeIssueComment[] };
  runner.comments = comments;
  return runner;
}

/** A valid, schema-conforming envelope for `key`, anchored on `headSha`. */
function makeEnvelope(headSha: string, patch: string = REV1_PATCH): AnalysisExport {
  const files = parseDiff(patch);
  const hunkIds = files.flatMap((f) => f.hunks.map((h) => h.id));
  return {
    format: "purview-analysis",
    version: 1,
    pr: { host: key.host, owner: key.owner, repo: key.repo, number: key.number },
    revision: 1,
    headSha,
    mergeBase: "mb1",
    exportedAt: "2024-03-01T00:00:00.000Z",
    summary: "A shared analysis.",
    units: [
      {
        id: "shared-unit",
        title: "Shared work",
        summary: "Imported from a teammate.",
        kind: "core-logic",
        attention: "must-read",
        attentionWhy: "shared",
        riskFlags: [],
        hunkIds,
        order: 1,
      },
    ],
  };
}

function seedMarkedComment(headSha: string, author = "teammate"): FakeIssueComment {
  const envelope = makeEnvelope(headSha);
  return {
    id: 1234,
    body: renderAnalysisComment(envelope),
    html_url: `https://github.com/${key.owner}/${key.repo}/pull/${key.number}#issuecomment-1234`,
    user: { login: author },
    created_at: "2024-03-01T00:00:00.000Z",
    updated_at: "2024-03-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-analysis-share-pr-"));
  process.env.PURVIEW_SKILL_DIR = path.join(root, "skills");
  process.env.PURVIEW_CLI_PATH = path.join(root, "cli.js");
  fs.mkdirSync(process.env.PURVIEW_SKILL_DIR, { recursive: true });
  app = createApp({ stateDir: root, webDist: path.join(root, "__no-web-dist__") });
  claude = fakeClaude({ lines: scriptedRun() });
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

/* -------------------------------------------------- share-to-pr / post-comment */

describe("POST /api/prs/:key/analysis/share-to-pr", () => {
  it("posts a new marked comment when none exists yet", async () => {
    buildFixture(root);
    const gh = ghWithComments();
    setGhRunner(gh);

    const res = await app.request(`/api/prs/${encodedKey}/analysis/share-to-pr`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(false);
    expect(body.commentUrl).toContain("issuecomment-");
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0].body).toContain("**Purview analysis**");
  });

  it("updates the existing marked comment on a second share, never duplicating it", async () => {
    buildFixture(root);
    const gh = ghWithComments();
    setGhRunner(gh);

    const first = await app.request(`/api/prs/${encodedKey}/analysis/share-to-pr`, { method: "POST" });
    expect((await first.json()).updated).toBe(false);
    expect(gh.comments).toHaveLength(1);
    const firstId = gh.comments[0].id;

    const second = await app.request(`/api/prs/${encodedKey}/analysis/share-to-pr`, { method: "POST" });
    const secondBody = await second.json();
    expect(secondBody.updated).toBe(true);
    expect(gh.comments).toHaveLength(1); // still just the one comment
    expect(gh.comments[0].id).toBe(firstId);
  });

  it("409s while an analysis is queued/running for this PR", async () => {
    buildFixture(root);
    claude.restore();
    claude = fakeClaude({ hang: true, lines: scriptedRun() });
    claude.install();
    const gh = ghWithComments();
    setGhRunner(gh);

    const analyzeRes = await app.request(`/api/prs/${encodedKey}/analyze`, { method: "POST" });
    expect(analyzeRes.status).toBe(200);

    const res = await app.request(`/api/prs/${encodedKey}/analysis/share-to-pr`, { method: "POST" });
    expect(res.status).toBe(409);

    await app.request(`/api/prs/${encodedKey}/analyze`, { method: "DELETE" });
    await analysisIdle();
  });
});

/* --------------------------------------------------------------- import-from-pr */

describe("POST /api/prs/:key/analysis/import-from-pr", () => {
  it("imports the newest marked comment and reports its provenance", async () => {
    buildFixture(root);
    const seeded = seedMarkedComment("head1", "teammate");
    const gh = ghWithComments({ seedComments: [seeded] });
    setGhRunner(gh);

    const res = await app.request(`/api/prs/${encodedKey}/analysis/import-from-pr`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.author).toBe("teammate");
    expect(body.postedAt).toBe(seeded.updated_at);
    expect(body.commentUrl).toBe(seeded.html_url);
    expect(body.report.unitsImported).toBe(1);

    const state = loadState(key, root);
    expect(state.units.map((u) => u.id)).toEqual(["shared-unit"]);
    expect(state.analysisOrigin).toBe("import");
  });

  it("404s with a clear error when no marked comment exists", async () => {
    buildFixture(root);
    setGhRunner(ghWithComments());

    const res = await app.request(`/api/prs/${encodedKey}/analysis/import-from-pr`, { method: "POST" });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("no_shared_analysis");
  });
});

/* --------------------------------------------------------------------- probe */

describe("GET /api/prs/:key/analysis/shared", () => {
  it("reports sameCommit: true when the shared envelope matches the current revision", async () => {
    buildFixture(root);
    setGhRunner(ghWithComments({ seedComments: [seedMarkedComment("head1")] }));

    const res = await app.request(`/api/prs/${encodedKey}/analysis/shared`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.found).toBe(true);
    expect(body.sameCommit).toBe(true);
    expect(body.headSha).toBe("head1");
  });

  it("reports sameCommit: false when the shared envelope is for a different revision", async () => {
    buildFixture(root);
    setGhRunner(ghWithComments({ seedComments: [seedMarkedComment("some-other-sha")] }));

    const res = await app.request(`/api/prs/${encodedKey}/analysis/shared`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.found).toBe(true);
    expect(body.sameCommit).toBe(false);
  });

  it("degrades to found:false, never throwing, when gh fails", async () => {
    buildFixture(root);
    setGhRunner(() => {
      throw new Error("gh api ... failed: HTTP 500");
    });

    const res = await app.request(`/api/prs/${encodedKey}/analysis/shared`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.found).toBe(false);
    expect(body.error).toBeTruthy();
  });
});

/* --------------------------------------------------- auto-detection: init path */

describe("POST /api/prs (init) — shared-analysis auto-detection", () => {
  it("imports an exact-sha shared analysis instead of spawning Claude", async () => {
    const seeded = seedMarkedComment("head1", "teammate");
    setGhRunner(ghWithComments({ patch: REV1_PATCH, sha: "1", seedComments: [seeded] }));

    const res = await app.request("/api/prs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `https://${key.host}/${key.owner}/${key.repo}/pull/${key.number}` }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.analysisJob).toBeNull();
    expect(body.sharedAnalysis).toEqual({ author: "teammate", postedAt: seeded.updated_at });
    expect(body.state.units.map((u: { id: string }) => u.id)).toEqual(["shared-unit"]);

    await analysisIdle();
    expect(claude.runs).toHaveLength(0);
  });

  it("leaves no analysis and no job when the shared comment is for a different revision", async () => {
    const seeded = seedMarkedComment("a-totally-different-sha", "teammate");
    setGhRunner(ghWithComments({ patch: REV1_PATCH, sha: "1", seedComments: [seeded] }));

    const res = await app.request("/api/prs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `https://${key.host}/${key.owner}/${key.repo}/pull/${key.number}` }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.analysisJob).toBeNull();
    expect(body.sharedAnalysis).toBeNull();
    expect(body.state.units).toEqual([]);

    await analysisIdle();
    expect(claude.runs).toHaveLength(0);
  });

  it("never imports as a side effect when ?analyze=false", async () => {
    const seeded = seedMarkedComment("head1", "teammate");
    setGhRunner(ghWithComments({ patch: REV1_PATCH, sha: "1", seedComments: [seeded] }));

    const res = await app.request("/api/prs?analyze=false", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `https://${key.host}/${key.owner}/${key.repo}/pull/${key.number}` }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.analysisJob).toBeNull();
    expect(body.sharedAnalysis).toBeNull();
    expect(body.state.units).toEqual([]);

    await analysisIdle();
    expect(claude.runs).toHaveLength(0);
  });
});

/* ------------------------------------------------- auto-detection: bulk/watch */

describe("importReviewRequestsSince — shared-analysis auto-detection", () => {
  const repo = { host: key.host, owner: key.owner, repo: key.repo };

  function ghForSearch(comments: FakeIssueComment[], sha = "1"): GhRunner {
    const base = ghWithComments({ patch: REV1_PATCH, sha, seedComments: comments });
    return (args: string[], input?: string) => {
      if (args[0] === "pr" && args[1] === "list") {
        return JSON.stringify([
          { number: key.number, title: "Add widgets", updatedAt: "2024-01-01T00:00:00Z" },
        ]);
      }
      return base(args, input);
    };
  }

  it("imports the shared analysis on an exact match, skipping the paid run", async () => {
    const seeded = seedMarkedComment("head1", "teammate");
    setGhRunner(ghForSearch([seeded]));

    const result = await importReviewRequestsSince(repo, new Date(0), root, { analyze: true });
    expect(result.imported).toEqual([keyToString(key)]);
    expect(result.sharedImports).toEqual([
      { key: keyToString(key), author: "teammate", postedAt: seeded.updated_at },
    ]);

    await analysisIdle();
    expect(claude.runs).toHaveLength(0);
    const state = loadState(key, root);
    expect(state.units.map((u) => u.id)).toEqual(["shared-unit"]);
  });

  it("falls back to a normal analysis run when the shared comment is for a different revision", async () => {
    const seeded = seedMarkedComment("a-totally-different-sha", "teammate");
    setGhRunner(ghForSearch([seeded]));

    const result = await importReviewRequestsSince(repo, new Date(0), root, { analyze: true });
    expect(result.imported).toEqual([keyToString(key)]);
    expect(result.sharedImports).toEqual([]);

    await analysisIdle();
    expect(claude.runs).toHaveLength(1); // fell back to a real (fake) Claude run
    const state = loadState(key, root);
    expect(state.units).toEqual([]); // the fake claude run in this suite writes nothing
  });

  it("never imports as a side effect when analyze consent is off", async () => {
    const seeded = seedMarkedComment("head1", "teammate");
    setGhRunner(ghForSearch([seeded]));

    const result = await importReviewRequestsSince(repo, new Date(0), root, { analyze: false });
    expect(result.imported).toEqual([keyToString(key)]);
    expect(result.sharedImports).toEqual([]);

    await analysisIdle();
    expect(claude.runs).toHaveLength(0);
    const state = loadState(key, root);
    expect(state.units).toEqual([]);
  });
});
