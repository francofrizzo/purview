import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureRepoConfig,
  initPr,
  keyToString,
  readMeta,
  readTeamConfigCache,
  refreshPr,
  repoConfigExists,
  repoConfigPath,
  setGhRunner,
  writeLocalChatInstructions,
  writeLocalRubric,
  writeRepoConfig,
  type ClaudeModel,
  type GhRunner,
} from "@reviewer/core";
import { createApp } from "../src/app.js";
import { chatInstructionsLayers, chatInstructionsSection } from "../src/chat-instructions.js";
import { chatSystemPrompt } from "../src/chat.js";
import { writeConfig } from "../src/config.js";
import {
  autoAnalyzeAllowed,
  effectiveAnalysisModel,
  effectiveChatModel,
  effectiveConfig,
  effectiveRepoPath,
} from "../src/repo-config.js";
import { loadCommittedConfig } from "../src/team-config.js";
import { rubricLayers, rubricSection } from "../src/rubric.js";
import { buildFixture, key, REV1_PATCH, REV2_PATCH } from "./fixtures.js";
import { makeRepo } from "./git-fixtures.js";

const repo = { host: key.host, owner: key.owner, repo: key.repo };
const encodedKey = encodeURIComponent(keyToString(key));
const encodedRepo = encodeURIComponent(`${repo.host}/${repo.owner}/${repo.repo}`);

let root: string;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-server-cfg-"));
  process.env.PURVIEW_SKILL_DIR = path.join(root, "skills");
  fs.mkdirSync(process.env.PURVIEW_SKILL_DIR, { recursive: true });
  buildFixture(root);
  app = createApp({ stateDir: root, webDist: path.join(root, "__no-web-dist__") });
});

afterEach(() => {
  setGhRunner(null);
  delete process.env.PURVIEW_SKILL_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * `gh` covering everything init/refresh touches, plus the two reads this
 * feature adds: the GraphQL review decision and the contents API.
 */
function ghFor(
  opts: {
    patch?: string;
    sha?: string;
    pull?: Record<string, unknown>;
    reviewDecision?: string | null;
    contents?: Record<string, string>;
  } = {},
): GhRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const runner = ((args: string[]) => {
    calls.push([...args]);
    const joined = args.join(" ");
    const sha = opts.sha ?? "1";
    if (args[1] === "graphql" && joined.includes("reviewDecision")) {
      return JSON.stringify({
        data: {
          repository: { pullRequest: { reviewDecision: opts.reviewDecision ?? null } },
        },
      });
    }
    const contents = joined.match(/contents\/([^\s?]+)/);
    if (contents) {
      const body = (opts.contents ?? {})[decodeURIComponent(contents[1])];
      if (body === undefined) throw new Error("gh: Not Found (HTTP 404)");
      return JSON.stringify({
        type: "file",
        encoding: "base64",
        content: Buffer.from(body, "utf8").toString("base64"),
      });
    }
    if (joined.includes("/compare/")) {
      return JSON.stringify({ merge_base_commit: { sha: `mb${sha}` } });
    }
    if (joined.includes("v3.diff")) return opts.patch ?? REV1_PATCH;
    if (/pulls\/\d+$/.test(args[args.length - 1] ?? "")) {
      return JSON.stringify({
        node_id: "PR_1",
        number: key.number,
        title: "Add widgets",
        html_url: `https://github.com/${key.owner}/${key.repo}/pull/${key.number}`,
        state: "open",
        draft: false,
        merged: false,
        base: { ref: "main", sha: `base${sha}` },
        head: { ref: "feature", sha: `head${sha}` },
        ...(opts.pull ?? {}),
      });
    }
    return "{}";
  }) as GhRunner & { calls: string[][] };
  runner.calls = calls;
  setGhRunner(runner);
  return runner;
}

/* ------------------------------------------------------------- precedence */

describe("effectiveConfig precedence", () => {
  interface Case {
    name: string;
    repoLocal?: boolean | null;
    committed?: boolean;
    global?: boolean;
    expected: boolean;
    source: string;
  }

  const cases: Case[] = [
    { name: "nothing configured anywhere", expected: true, source: "default" },
    { name: "global only", global: false, expected: false, source: "global" },
    { name: "global only, on", global: true, expected: true, source: "global" },
    {
      name: "committed beats global",
      committed: true,
      global: false,
      expected: true,
      source: "committed",
    },
    {
      name: "committed off beats global on",
      committed: false,
      global: true,
      expected: false,
      source: "committed",
    },
    {
      name: "repo beats committed",
      repoLocal: false,
      committed: true,
      global: true,
      expected: false,
      source: "repo",
    },
    {
      name: "repo on beats committed off and global off",
      repoLocal: true,
      committed: false,
      global: false,
      expected: true,
      source: "repo",
    },
    {
      name: "explicit null in repo.json inherits rather than pinning false",
      repoLocal: null,
      committed: true,
      global: false,
      expected: true,
      source: "committed",
    },
  ];

  for (const c of cases) {
    it(`autoAnalyze: ${c.name}`, () => {
      if (c.repoLocal !== undefined) writeRepoConfig(repo, { autoAnalyze: c.repoLocal }, root);
      if (c.global !== undefined) writeConfig({ autoAnalyze: c.global }, root);
      const resolved = effectiveConfig(key, root, {
        committed: c.committed === undefined ? null : { autoAnalyze: c.committed },
      });
      expect(resolved.autoAnalyze.value).toBe(c.expected);
      expect(resolved.autoAnalyze.source).toBe(c.source);
    });
  }

  it("repoPath: PR meta overrides repo.json, which overrides nothing", () => {
    expect(effectiveConfig(key, root).repoPath).toEqual({ value: null, source: "default" });

    writeRepoConfig(repo, { repoPath: "/checkouts/widgets" }, root);
    expect(effectiveConfig(key, root).repoPath).toEqual({
      value: "/checkouts/widgets",
      source: "repo",
    });
    expect(effectiveRepoPath(key, root)).toBe("/checkouts/widgets");

    const meta = { ...readMeta(key, root), repoPath: "/wt/pr-7" };
    expect(effectiveConfig(key, root, { meta }).repoPath).toEqual({
      value: "/wt/pr-7",
      source: "pr",
    });
    expect(effectiveRepoPath(key, root, { meta })).toBe("/wt/pr-7");
  });

  /**
   * Model precedence, for both keys at once: repo.json > committed >
   * ~/.purview/config.json > built-in "sonnet". Unlike autoAnalyze the global
   * layer is nullable, so it can be present-but-inheriting.
   */
  const modelCases: {
    name: string;
    repoLocal?: ClaudeModel | null;
    committed?: ClaudeModel;
    global?: ClaudeModel | null;
    expected: ClaudeModel;
    source: string;
  }[] = [
    { name: "nothing set anywhere falls back to sonnet", expected: "sonnet", source: "default" },
    { name: "global alone decides", global: "haiku", expected: "haiku", source: "global" },
    {
      name: "committed beats global",
      committed: "opus",
      global: "haiku",
      expected: "opus",
      source: "committed",
    },
    {
      name: "repo.json beats committed and global",
      repoLocal: "haiku",
      committed: "opus",
      global: "opus",
      expected: "haiku",
      source: "repo",
    },
    {
      name: "explicit null in repo.json inherits rather than pinning",
      repoLocal: null,
      committed: "opus",
      expected: "opus",
      source: "committed",
    },
    {
      name: "a null global is inherit, not a pin, so the built-in default wins",
      global: null,
      expected: "sonnet",
      source: "default",
    },
  ];

  for (const c of modelCases) {
    for (const field of ["analysisModel", "chatModel"] as const) {
      it(`${field}: ${c.name}`, () => {
        if (c.repoLocal !== undefined) writeRepoConfig(repo, { [field]: c.repoLocal }, root);
        if (c.global !== undefined) writeConfig({ [field]: c.global }, root);
        const resolved = effectiveConfig(key, root, {
          committed: c.committed === undefined ? null : { [field]: c.committed },
        });
        expect(resolved[field].value).toBe(c.expected);
        expect(resolved[field].source).toBe(c.source);
        // The two keys are independent: setting one must not move the other.
        const other = field === "analysisModel" ? "chatModel" : "analysisModel";
        if (c.repoLocal || c.committed || c.global) {
          expect(resolved[other].source).toBe("default");
        }
      });
    }
  }

  it("effectiveAnalysisModel / effectiveChatModel are the resolver's values", () => {
    writeRepoConfig(repo, { analysisModel: "haiku", chatModel: "opus" }, root);
    expect(effectiveAnalysisModel(key, root)).toBe("haiku");
    expect(effectiveChatModel(key, root)).toBe("opus");
  });

  it("an archived PR never auto-analyzes, whatever the layers say", () => {
    writeRepoConfig(repo, { autoAnalyze: true }, root);
    expect(autoAnalyzeAllowed(key, root)).toBe(true);
    const meta = { ...readMeta(key, root), archived: true };
    expect(autoAnalyzeAllowed(key, root, { meta })).toBe(false);
  });
});

/* ------------------------------------------------------- committed config */

describe("committed .purview/ config", () => {
  it("reads config and rubric out of a local checkout, without touching gh", () => {
    const gh = ghFor();
    const checkout = makeRepo(path.join(root, "checkout"), {
      origin: "git@github.com:acme/widgets.git",
      branch: "feature",
    });
    fs.mkdirSync(path.join(checkout.path, ".purview"), { recursive: true });
    fs.writeFileSync(
      path.join(checkout.path, ".purview/config.json"),
      JSON.stringify({ autoAnalyze: false, somethingNew: "ignored" }),
    );
    fs.writeFileSync(path.join(checkout.path, ".purview/RUBRIC.md"), "# Team rules\n");
    fs.writeFileSync(path.join(checkout.path, ".purview/CHAT.md"), "# Team chat rules\n");
    writeRepoConfig(repo, { repoPath: checkout.path }, root);

    const committed = loadCommittedConfig(key, root);

    expect(committed.source).toBe("checkout");
    expect(committed.present).toBe(true);
    expect(committed.config).toEqual({ autoAnalyze: false });
    expect(committed.rubric).toBe("# Team rules\n");
    expect(committed.chatInstructions).toBe("# Team chat rules\n");
    expect(gh.calls.filter((c) => c.join(" ").includes("contents/"))).toHaveLength(0);
    // ...and it now decides autoAnalyze, since nothing more specific is set.
    expect(autoAnalyzeAllowed(key, root)).toBe(false);
  });

  it("falls back to the contents API at the head sha, and caches per revision", () => {
    const gh = ghFor({
      contents: {
        ".purview/config.json": JSON.stringify({ autoAnalyze: true }),
        ".purview/RUBRIC.md": "# Committed rubric\n",
        ".purview/CHAT.md": "# Committed chat\n",
      },
    });

    const first = loadCommittedConfig(key, root);
    expect(first.source).toBe("github");
    expect(first.config).toEqual({ autoAnalyze: true });
    expect(first.rubric).toBe("# Committed rubric\n");
    expect(first.chatInstructions).toBe("# Committed chat\n");

    const fetches = () => gh.calls.filter((c) => c.join(" ").includes("contents/")).length;
    const afterFirst = fetches();
    expect(afterFirst).toBeGreaterThan(0);
    // The ref is the revision's head sha.
    expect(gh.calls.find((c) => c.join(" ").includes("contents/"))?.join(" ")).toContain(
      "ref=head1",
    );

    // Cached: a second load is free.
    loadCommittedConfig(key, root);
    expect(fetches()).toBe(afterFirst);
    expect(readTeamConfigCache(key, 1, root)?.present).toBe(true);
    expect(readTeamConfigCache(key, 1, root)?.chatInstructions).toBe("# Committed chat\n");

    // ...unless it is explicitly refreshed.
    loadCommittedConfig(key, root, { refresh: true });
    expect(fetches()).toBeGreaterThan(afterFirst);
  });

  it("reads CHAT.md from GitHub even when the checkout has only RUBRIC.md/config.json", () => {
    // The checkout-preferred path only skips gh entirely when it found
    // *something*; when it found something but not CHAT.md, the checkout is
    // still the source of truth and an absent CHAT.md there stays absent —
    // this test documents the checkout path does not also merge in gh.
    const checkout = makeRepo(path.join(root, "checkout2"), {
      origin: "git@github.com:acme/widgets.git",
      branch: "feature",
    });
    fs.mkdirSync(path.join(checkout.path, ".purview"), { recursive: true });
    fs.writeFileSync(path.join(checkout.path, ".purview/RUBRIC.md"), "# Team rules\n");
    writeRepoConfig(repo, { repoPath: checkout.path }, root);

    const committed = loadCommittedConfig(key, root);
    expect(committed.source).toBe("checkout");
    expect(committed.chatInstructions).toBeNull();
  });

  it("treats a repo with no .purview/ as simply unconfigured", () => {
    ghFor();
    const committed = loadCommittedConfig(key, root);
    expect(committed).toMatchObject({
      present: false,
      config: null,
      rubric: null,
      chatInstructions: null,
      source: "none",
    });
  });

  it("reads an old cache file written before the chatInstructions field existed", () => {
    // Simulates a team-config.json cached by a server build that predates
    // this feature: no `chatInstructions` key at all. buildFixture() (in
    // beforeEach) already created revision 1 for this PR.
    const cachePath = path.join(
      root,
      key.host,
      key.owner,
      key.repo,
      String(key.number),
      "revisions",
      "1",
      "team-config.json",
    );
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        ref: "head1",
        fetchedAt: new Date().toISOString(),
        source: "github",
        present: true,
        config: { autoAnalyze: true },
        rubric: "# Old cache rubric\n",
      }),
    );

    const cache = readTeamConfigCache(key, 1, root);
    expect(cache?.chatInstructions).toBeNull();
    expect(cache?.rubric).toBe("# Old cache rubric\n");
    expect(cache?.present).toBe(true);
  });
});

/* ------------------------------------------------------------------ rubric */

describe("rubric layering", () => {
  it("concatenates built-in, then committed team, then local overlay", () => {
    ghFor({
      contents: { ".purview/RUBRIC.md": "TEAM RUBRIC BODY" },
    });
    loadCommittedConfig(key, root);
    writeLocalRubric(repo, "LOCAL RUBRIC BODY", root);

    const layers = rubricLayers(key, root);
    expect(layers.map((l) => l.level)).toEqual([1, 2, 3]);
    expect(layers[0].path).toBe(path.join(process.env.PURVIEW_SKILL_DIR!, "RUBRIC.md"));
    expect(layers[1].content).toBe("TEAM RUBRIC BODY");
    expect(layers[2].content).toBe("LOCAL RUBRIC BODY");

    const section = rubricSection(key, root);
    expect(section.indexOf("LAYER 1")).toBeLessThan(section.indexOf("LAYER 2"));
    expect(section.indexOf("LAYER 2")).toBeLessThan(section.indexOf("LAYER 3"));
    expect(section.indexOf("TEAM RUBRIC BODY")).toBeLessThan(
      section.indexOf("LOCAL RUBRIC BODY"),
    );
    expect(section).toContain("team rubric — refines the above");
    expect(section).toContain("local overlay — highest precedence");
  });

  it("adds nothing to the prompt when only the built-in rubric exists", () => {
    ghFor();
    expect(rubricSection(key, root)).toBe("");
    expect(rubricLayers(key, root)).toHaveLength(1);
  });

  it("keeps the local overlay even with no committed rubric", () => {
    ghFor();
    writeLocalRubric(repo, "LOCAL ONLY", root);
    const layers = rubricLayers(key, root);
    expect(layers.map((l) => l.level)).toEqual([1, 3]);
    expect(rubricSection(key, root)).toContain("LOCAL ONLY");
  });
});

/* -------------------------------------------------------- chat instructions */

describe("chat instructions layering", () => {
  it("concatenates committed team chat instructions, then local overlay", () => {
    ghFor({
      contents: { ".purview/CHAT.md": "TEAM CHAT BODY" },
    });
    loadCommittedConfig(key, root);
    writeLocalChatInstructions(repo, "LOCAL CHAT BODY", root);

    const layers = chatInstructionsLayers(key, root);
    expect(layers.map((l) => l.level)).toEqual([1, 2]);
    expect(layers[0].content).toBe("TEAM CHAT BODY");
    expect(layers[1].content).toBe("LOCAL CHAT BODY");

    const section = chatInstructionsSection(key, root);
    expect(section.indexOf("LAYER 1")).toBeLessThan(section.indexOf("LAYER 2"));
    expect(section.indexOf("TEAM CHAT BODY")).toBeLessThan(section.indexOf("LOCAL CHAT BODY"));
    expect(section).toContain("team chat instructions — repo-specific guidance");
    expect(section).toContain("local overlay — highest precedence");
  });

  it("is empty when neither overlay exists", () => {
    ghFor();
    expect(chatInstructionsSection(key, root)).toBe("");
    expect(chatInstructionsLayers(key, root)).toHaveLength(0);
  });

  it("keeps the local overlay even with no committed chat instructions", () => {
    ghFor();
    writeLocalChatInstructions(repo, "LOCAL ONLY", root);
    const layers = chatInstructionsLayers(key, root);
    expect(layers.map((l) => l.level)).toEqual([2]);
    expect(chatInstructionsSection(key, root)).toContain("LOCAL ONLY");
  });

  it("does not appear in the analysis rubric prompt", () => {
    ghFor({ contents: { ".purview/CHAT.md": "TEAM CHAT BODY" } });
    loadCommittedConfig(key, root);
    writeLocalChatInstructions(repo, "LOCAL CHAT BODY", root);
    expect(rubricSection(key, root)).not.toContain("CHAT");
  });

  it("appears in the chat system prompt, after the rubric stack", () => {
    ghFor({
      contents: {
        ".purview/RUBRIC.md": "TEAM RUBRIC BODY",
        ".purview/CHAT.md": "TEAM CHAT BODY",
      },
    });
    const committed = loadCommittedConfig(key, root);
    writeLocalRubric(repo, "LOCAL RUBRIC BODY", root);
    writeLocalChatInstructions(repo, "LOCAL CHAT BODY", root);

    const prompt = chatSystemPrompt(key, root, undefined, { committed });

    expect(prompt).toContain("TEAM RUBRIC BODY");
    expect(prompt).toContain("LOCAL RUBRIC BODY");
    expect(prompt).toContain("TEAM CHAT BODY");
    expect(prompt).toContain("LOCAL CHAT BODY");
    // The rubric stack (level markers "RUBRIC LAYER") comes entirely before
    // the chat instructions stack ("CHAT LAYER").
    expect(prompt.indexOf("END REVIEW RUBRIC")).toBeLessThan(
      prompt.indexOf("CHAT INSTRUCTIONS — LAYERED"),
    );
    expect(prompt.indexOf("CHAT LAYER 1")).toBeLessThan(prompt.indexOf("CHAT LAYER 2"));
  });

  it("leaves the chat prompt byte-identical to today's when no overlay exists", () => {
    ghFor();
    const withNothing = chatSystemPrompt(key, root);
    expect(withNothing).not.toContain("CHAT INSTRUCTIONS");
    expect(withNothing).not.toContain("REVIEW RUBRIC");
  });
});

/* --------------------------------------------------- init / refresh capture */

describe("init and refresh capture", () => {
  const freshKey = { ...repo, number: 42 };

  it("creates an empty repo.json with the first PR of a repo", () => {
    const other = { host: "github.com", owner: "acme", repo: "gadgets" };
    expect(repoConfigExists(other, root)).toBe(false);
    ghFor();
    initPr({ ...other, number: 3 }, root);
    expect(repoConfigExists(other, root)).toBe(true);
    expect(JSON.parse(fs.readFileSync(repoConfigPath(other, root), "utf8"))).toEqual({
      autoAnalyze: null,
      repoPath: null,
      analysisModel: null,
      chatModel: null,
    });
  });

  it("records state, review decision and addedAt on init", () => {
    ghFor({ pull: { draft: true }, reviewDecision: "CHANGES_REQUESTED" });
    initPr(freshKey, root);
    const meta = readMeta(freshKey, root);
    expect(meta.prState).toBe("draft");
    expect(meta.reviewDecision).toBe("changes_requested");
    expect(meta.archived).toBe(false);
    expect(meta.createdAt).toBeTruthy();
  });

  it("updates state and review decision on refresh", () => {
    ghFor({ reviewDecision: null });
    initPr(freshKey, root);
    expect(readMeta(freshKey, root).reviewDecision).toBeNull();

    ghFor({
      sha: "2",
      patch: REV2_PATCH,
      pull: { state: "closed", merged: true },
      reviewDecision: "APPROVED",
    });
    refreshPr(freshKey, root);

    const meta = readMeta(freshKey, root);
    expect(meta.prState).toBe("merged");
    expect(meta.reviewDecision).toBe("approved");
  });

  it("never fails a refresh because the review-decision query failed", () => {
    ghFor();
    initPr(freshKey, root);
    setGhRunner((args) => {
      if (args[1] === "graphql") throw new Error("gh graphql failed: HTTP 502");
      return ghFor({ sha: "3", patch: REV2_PATCH })(args);
    });
    expect(() => refreshPr(freshKey, root)).not.toThrow();
    expect(readMeta(freshKey, root).reviewDecision).toBeNull();
  });
});

/* --------------------------------------------------------------- endpoints */

describe("GET /api/prs contract fields", () => {
  it("carries state, reviewDecision, addedAt, archived and title", async () => {
    const body = await (await app.request("/api/prs")).json();
    const pr = body.prs[0];
    expect(pr.title).toBe("Add widgets");
    expect(pr.state).toBe("open");
    expect(pr.reviewDecision).toBeNull();
    expect(pr.addedAt).toBe(readMeta(key, root).createdAt);
    expect(pr.archived).toBe(false);
  });
});

describe("POST /api/prs/:key/archive", () => {
  it("round-trips and keeps the PR fully readable", async () => {
    const res = await app.request(`/api/prs/${encodedKey}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, archived: true });
    expect(readMeta(key, root).archived).toBe(true);

    const list = await (await app.request("/api/prs")).json();
    expect(list.prs[0].archived).toBe(true);
    expect((await app.request(`/api/prs/${encodedKey}`)).status).toBe(200);

    const back = await app.request(`/api/prs/${encodedKey}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: false }),
    });
    expect(await back.json()).toEqual({ ok: true, archived: false });
  });

  it("400s on a non-boolean and 404s on an unknown PR", async () => {
    const bad = await app.request(`/api/prs/${encodedKey}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: "yes" }),
    });
    expect(bad.status).toBe(400);
    const missing = await app.request(
      `/api/prs/${encodeURIComponent("github.com/acme/nope/1")}/archive`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: true }),
      },
    );
    expect(missing.status).toBe(404);
  });

  it("keeps an archived PR out of the automatic analysis trigger", async () => {
    ghFor({ sha: "9", patch: REV2_PATCH });
    await app.request(`/api/prs/${encodedKey}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    const res = await app.request(`/api/prs/${encodedKey}/refresh`, { method: "POST" });
    const body = await res.json();
    expect(body.added).toBe(true);
    expect(body.analysisJob).toBeNull();
  });
});

describe("GET /api/repos", () => {
  it("aggregates PR counts and which layers are configured", async () => {
    ensureRepoConfig(repo, root);
    const body = await (await app.request("/api/repos")).json();
    expect(body.repos).toHaveLength(1);
    expect(body.repos[0]).toMatchObject({
      host: repo.host,
      owner: repo.owner,
      repo: repo.repo,
      prCount: 1,
      archivedCount: 0,
      // An auto-created, all-null repo.json is not "configured".
      hasLocalConfig: false,
      hasCommittedConfig: false,
      repoPath: null,
    });

    writeRepoConfig(repo, { repoPath: "/checkouts/widgets" }, root);
    await app.request(`/api/prs/${encodedKey}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    ghFor({ contents: { ".purview/config.json": JSON.stringify({ autoAnalyze: false }) } });
    loadCommittedConfig(key, root);

    const after = await (await app.request("/api/repos")).json();
    expect(after.repos[0]).toMatchObject({
      prCount: 1,
      archivedCount: 1,
      hasLocalConfig: true,
      hasCommittedConfig: true,
      repoPath: "/checkouts/widgets",
    });
  });

  it("makes no network call while listing", async () => {
    const gh = ghFor({ contents: { ".purview/config.json": "{}" } });
    await app.request("/api/repos");
    expect(gh.calls).toHaveLength(0);
  });
});

describe("/api/repos/:rkey/config", () => {
  it("returns local, committed and effective layers", async () => {
    ghFor({
      contents: {
        ".purview/config.json": JSON.stringify({ autoAnalyze: false }),
        ".purview/RUBRIC.md": "# Team\n",
        ".purview/CHAT.md": "# Team chat\n",
      },
    });
    const body = await (await app.request(`/api/repos/${encodedRepo}/config`)).json();
    expect(body.local).toEqual({
      autoAnalyze: null,
      repoPath: null,
      analysisModel: null,
      chatModel: null,
      rubric: "",
      chatInstructions: "",
    });
    expect(body.committed).toEqual({
      present: true,
      config: { autoAnalyze: false },
      rubric: "# Team\n",
      chat: "# Team chat\n",
    });
    expect(body.effective).toEqual({
      autoAnalyze: false,
      repoPath: null,
      analysisModel: "sonnet",
      chatModel: "sonnet",
    });
  });

  it("writes local values, and null re-inherits", async () => {
    ghFor({ contents: { ".purview/config.json": JSON.stringify({ autoAnalyze: false }) } });
    const checkout = makeRepo(path.join(root, "co"), { origin: "git@github.com:acme/widgets.git" });

    const put = await app.request(`/api/repos/${encodedRepo}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        autoAnalyze: true,
        repoPath: checkout.path,
        rubric: "# Local\n",
        chatInstructions: "# Local chat\n",
      }),
    });
    expect(put.status).toBe(200);
    const body = await put.json();
    expect(body.local).toEqual({
      autoAnalyze: true,
      repoPath: checkout.path,
      analysisModel: null,
      chatModel: null,
      rubric: "# Local\n",
      chatInstructions: "# Local chat\n",
    });
    expect(body.effective.autoAnalyze).toBe(true);
    expect(body.sources.autoAnalyze).toBe("repo");

    const cleared = await app.request(`/api/repos/${encodedRepo}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoAnalyze: null, rubric: "", chatInstructions: "" }),
    });
    const clearedBody = await cleared.json();
    expect(clearedBody.local.autoAnalyze).toBeNull();
    expect(clearedBody.local.rubric).toBe("");
    expect(clearedBody.local.chatInstructions).toBe("");
    // repoPath was not in the body, so it was left alone.
    expect(clearedBody.local.repoPath).toBe(checkout.path);
    // ...and the committed layer takes over again.
    expect(clearedBody.effective.autoAnalyze).toBe(false);
    expect(clearedBody.sources.autoAnalyze).toBe("committed");
  });

  it("stores model choices per repo and reports their source", async () => {
    ghFor({ contents: { ".purview/config.json": JSON.stringify({ chatModel: "haiku" }) } });

    const before = await (await app.request(`/api/repos/${encodedRepo}/config`)).json();
    expect(before.effective.analysisModel).toBe("sonnet");
    expect(before.sources.analysisModel).toBe("default");
    expect(before.effective.chatModel).toBe("haiku");
    expect(before.sources.chatModel).toBe("committed");

    const put = await app.request(`/api/repos/${encodedRepo}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ analysisModel: "opus", chatModel: "opus" }),
    });
    const body = await put.json();
    expect(body.local.analysisModel).toBe("opus");
    expect(body.effective).toMatchObject({ analysisModel: "opus", chatModel: "opus" });
    expect(body.sources).toMatchObject({ analysisModel: "repo", chatModel: "repo" });

    const cleared = await app.request(`/api/repos/${encodedRepo}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatModel: null }),
    });
    const clearedBody = await cleared.json();
    expect(clearedBody.local.chatModel).toBeNull();
    expect(clearedBody.effective.chatModel).toBe("haiku");
    expect(clearedBody.sources.chatModel).toBe("committed");
    // analysisModel was not in the body, so it kept its value.
    expect(clearedBody.local.analysisModel).toBe("opus");
  });

  it("rejects an unknown model name", async () => {
    const put = await app.request(`/api/repos/${encodedRepo}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ analysisModel: "claude-opus-4-6" }),
    });
    expect(put.status).toBe(400);
  });

  it("rejects bad types, unknown keys and a missing directory", async () => {
    const put = async (body: unknown) =>
      app.request(`/api/repos/${encodedRepo}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    expect((await put({ autoAnalyze: "yes" })).status).toBe(400);
    expect((await put({ repoPath: 7 })).status).toBe(400);
    expect((await put({ rubric: 12 })).status).toBe(400);
    expect((await put({ chatInstructions: 12 })).status).toBe(400);
    expect((await put({ nope: true })).status).toBe(400);

    const missing = await put({ repoPath: path.join(root, "does-not-exist") });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toBe("repo_path_missing");
  });

  it("accepts the rkey URL-encoded, and 400s on a malformed one", async () => {
    ghFor();
    writeRepoConfig(repo, { autoAnalyze: true }, root);
    const encoded = await app.request(`/api/repos/${encodedRepo}/config`);
    expect(encoded.status).toBe(200);
    expect((await encoded.json()).repo).toBe("github.com/acme/widgets");

    // An enterprise host round-trips the same way.
    const ghe = encodeURIComponent("git.corp.io/acme/widgets");
    const gheRes = await app.request(`/api/repos/${ghe}/config`);
    expect(gheRes.status).toBe(200);
    expect((await gheRes.json()).repo).toBe("git.corp.io/acme/widgets");

    const bad = await app.request(`/api/repos/${encodeURIComponent("justrepo")}/config`);
    expect(bad.status).toBe(400);
  });
});

/* --------------------------------------------------------- global config */

describe("/api/config", () => {
  it("reports the machine-wide model settings and the built-in defaults", async () => {
    const body = await (await app.request("/api/config")).json();
    expect(body).toEqual({
      analysisModel: null,
      chatModel: null,
      defaults: { analysisModel: "sonnet", chatModel: "sonnet" },
    });
  });

  it("writes them, and they become the global layer of the resolver", async () => {
    const put = await app.request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ analysisModel: "haiku" }),
    });
    expect(put.status).toBe(200);
    expect((await put.json()).analysisModel).toBe("haiku");

    const resolved = effectiveConfig(key, root);
    expect(resolved.analysisModel).toEqual({ value: "haiku", source: "global" });
    // The other key was not written, so it still inherits the built-in default.
    expect(resolved.chatModel).toEqual({ value: "sonnet", source: "default" });

    // A partial PUT leaves the rest of config.json alone.
    const second = await app.request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatModel: "opus" }),
    });
    expect(await second.json()).toMatchObject({ analysisModel: "haiku", chatModel: "opus" });
  });

  it("null re-inherits the built-in default", async () => {
    writeConfig({ chatModel: "opus" }, root);
    const put = await app.request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatModel: null }),
    });
    expect((await put.json()).chatModel).toBeNull();
    expect(effectiveConfig(key, root).chatModel.source).toBe("default");
  });

  it("400s on an unknown model or an unknown key", async () => {
    for (const bad of [{ chatModel: "gpt-5" }, { autoAnalyze: true }, { chatModel: 3 }]) {
      const res = await app.request("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bad),
      });
      expect(res.status).toBe(400);
    }
  });
});
