import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  analysisJobPath,
  chatPath,
  keyToString,
  parseDiff,
  readEvents,
  readMeta,
  setGhRunner,
  toRevisionFiles,
  writeRepoConfig,
  updateMeta,
  appendEvents,
  writeRevision,
  type GhRunner,
} from "@reviewer/core";
import { createApp } from "../src/app.js";
import {
  analysisIdle,
  analysisToolFlags,
  findingsNote,
  readJob,
  reconcileStaleJobs,
} from "../src/analysis.js";
import { chatTurnDone } from "../src/chat-session.js";
import { resolveRefs } from "../src/chat.js";
import { ownerRepoFromRemote } from "../src/repo-path.js";
import { HttpError } from "../src/http-error.js";
import { buildFixture, key, DOD_REV1, DOD_REV2, REV1_PATCH } from "./fixtures.js";
import { fakeClaude, scriptedRun, type FakeClaude } from "./fake-claude.js";
import { addWorktree, makeRepo } from "./git-fixtures.js";

const encodedKey = encodeURIComponent(keyToString(key));

let root: string;
let app: ReturnType<typeof createApp>;
let claude: FakeClaude;

/**
 * Minimal `gh` covering just init/refresh (PR meta, merge base, diff).
 * `sha` distinguishes revisions: refresh only stores a new one when the shas
 * move, so each stage of a test needs its own.
 */
function ghFor(patches: string[], sha = "1"): GhRunner {
  let calls = 0;
  return (args) => {
    const joined = args.join(" ");
    if (joined.includes("/compare/")) {
      return JSON.stringify({ merge_base_commit: { sha: `mb${sha}` } });
    }
    if (joined.includes("v3.diff")) {
      return patches[Math.min(calls++, patches.length - 1)];
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
    return "{}";
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-claude-test-"));
  process.env.REVIEWER_SKILL_DIR = path.join(root, "skills");
  process.env.REVIEWER_CLI_PATH = path.join(root, "cli.js");
  fs.mkdirSync(process.env.REVIEWER_SKILL_DIR, { recursive: true });
  claude = fakeClaude();
  claude.install();
  // Analysis and chat runs read the repo's committed `.purview/` config; with
  // no runner installed that would reach the real `gh`. Nothing here has one.
  setGhRunner(() => "{}");
  app = createApp({
    stateDir: root,
    webDist: path.join(root, "__no-web-dist__"),
    analysisTimeoutMs: 10_000,
  });
});

afterEach(async () => {
  await analysisIdle();
  claude.restore();
  setGhRunner(null);
  delete process.env.REVIEWER_SKILL_DIR;
  delete process.env.REVIEWER_CLI_PATH;
  fs.rmSync(root, { recursive: true, force: true });
});

/* ------------------------------------------------------------ job lifecycle */

/* ------------------------------------------------------- verification gate */

describe("findings gating text", () => {
  it("switches the verification pass on only when a checkout resolved", () => {
    const on = findingsNote({ path: "/src/widgets" });
    expect(on).toContain("VERIFICATION PASS: RUN IT");
    expect(on).toContain("at most 5 entries");
    expect(on).toContain("never posted anywhere");

    // A resolved-but-stale checkout is still a checkout.
    expect(
      findingsNote({
        path: "/src/widgets",
        mismatch: { checkedOutBranch: "main", prHeadRef: "feature-x" },
      }),
    ).toContain("VERIFICATION PASS: RUN IT");
  });

  it("forbids findings outright when there is no usable checkout", () => {
    for (const resolution of [
      undefined,
      {},
      { path: undefined },
      { path: "/src/widgets", error: "no longer exists" },
    ]) {
      const off = findingsNote(resolution as Parameters<typeof findingsNote>[0]);
      expect(off).toContain("VERIFICATION PASS: SKIPPED");
      expect(off).toContain("Do NOT emit any findings");
      expect(off).not.toContain("RUN IT");
    }
  });
});

describe("analysis tool allowlist", () => {
  it("permits batched read-only investigation but never writes, gh or git", () => {
    const { tools, allowedTools, disallowedTools } = analysisToolFlags();
    expect(tools).not.toContain("Write");
    expect(tools).not.toContain("Edit");
    // Batched investigation (`grep … && sed -n …`) needs these allowed outright.
    for (const rule of ["Bash(grep:*)", "Bash(sed -n:*)", "Bash(ls:*)", "Bash(cat:*)"]) {
      expect(allowedTools).toContain(rule);
    }
    // In-place sed must not be reachable through the `sed` allowance.
    expect(allowedTools).not.toContain("Bash(sed:*)");
    for (const rule of ["Bash(gh:*)", "Bash(git:*)", "Edit"]) {
      expect(disallowedTools).toContain(rule);
    }
  });
});

describe("analysis job lifecycle", () => {
  it("runs queued -> running -> done and records the events", async () => {
    buildFixture(root);
    const res = await app.request(`/api/prs/${encodedKey}/analyze`, { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json()).job.status).toBe("queued");

    await analysisIdle();
    const job = readJob(key, root)!;
    expect(job.status).toBe("done");
    expect(job.revision).toBe(1);
    expect(job.startedAt).toBeTruthy();
    expect(job.finishedAt).toBeTruthy();

    const types = readEvents(key, root).map((e) => e.type);
    expect(types).toContain("analysis-started");
    expect(types).toContain("analysis-finished");
    expect(fs.existsSync(analysisJobPath(key, root))).toBe(true);
  });

  it("marks the job failed when claude exits non-zero", async () => {
    buildFixture(root);
    claude.restore();
    claude = fakeClaude({ exitCode: 3, stderr: "boom", lines: scriptedRun({ isError: true }) });
    claude.install();

    await app.request(`/api/prs/${encodedKey}/analyze`, { method: "POST" });
    await analysisIdle();

    const job = readJob(key, root)!;
    expect(job.status).toBe("failed");
    expect(job.error).toContain("exited with code 3");
    expect(job.error).toContain("boom");
  });

  it("409s when an analysis is already queued or running", async () => {
    buildFixture(root);
    claude.restore();
    claude = fakeClaude({ hang: true, lines: scriptedRun() });
    claude.install();

    const first = await app.request(`/api/prs/${encodedKey}/analyze`, { method: "POST" });
    expect(first.status).toBe(200);
    const second = await app.request(`/api/prs/${encodedKey}/analyze`, { method: "POST" });
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe("analysis_in_progress");

    await app.request(`/api/prs/${encodedKey}/analyze`, { method: "DELETE" });
    await analysisIdle();
  });

  it("cancels a running job", async () => {
    buildFixture(root);
    claude.restore();
    claude = fakeClaude({ hang: true, lines: scriptedRun() });
    claude.install();

    await app.request(`/api/prs/${encodedKey}/analyze`, { method: "POST" });
    // Wait for the slot to actually pick it up before cancelling.
    for (let i = 0; i < 200 && readJob(key, root)?.status !== "running"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(readJob(key, root)!.status).toBe("running");

    const res = await app.request(`/api/prs/${encodedKey}/analyze`, { method: "DELETE" });
    expect(res.status).toBe(200);
    await analysisIdle();
    expect(readJob(key, root)!.status).toBe("cancelled");
    const finished = readEvents(key, root).filter((e) => e.type === "analysis-finished");
    expect(finished.at(-1)).toMatchObject({ status: "cancelled" });
  });

  it("409s on cancel when nothing is in progress", async () => {
    buildFixture(root);
    const res = await app.request(`/api/prs/${encodedKey}/analyze`, { method: "DELETE" });
    expect(res.status).toBe(409);
  });

  it("marks a job left `running` by a crashed server as failed on startup", async () => {
    buildFixture(root);
    fs.writeFileSync(
      analysisJobPath(key, root),
      JSON.stringify({ revision: 1, status: "running", startedAt: new Date().toISOString() }),
    );
    reconcileStaleJobs(root);
    const job = readJob(key, root)!;
    expect(job.status).toBe("failed");
    expect(job.error).toBe("server restarted");
  });

  it("exposes the job on the list and detail endpoints", async () => {
    buildFixture(root);
    await app.request(`/api/prs/${encodedKey}/analyze`, { method: "POST" });
    await analysisIdle();

    const list = await (await app.request("/api/prs")).json();
    expect(list.prs[0].analysisJob.status).toBe("done");
    const detail = await (await app.request(`/api/prs/${encodedKey}`)).json();
    expect(detail.analysisJob.status).toBe("done");
    const single = await (await app.request(`/api/prs/${encodedKey}/analysis-job`)).json();
    expect(single.job.status).toBe("done");
  });

  it("restricts the analysis run's tools and points it at the state dir", async () => {
    buildFixture(root);
    await app.request(`/api/prs/${encodedKey}/analyze`, { method: "POST" });
    await analysisIdle();

    const run = claude.runs[0];
    const argv = run.argv.join(" ");
    expect(run.cwd).toBe(path.join(root, key.host, key.owner, key.repo, String(key.number)));
    expect(argv).toContain("--output-format stream-json");
    expect(argv).toContain("--safe-mode");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).toContain("--tools Read,Glob,Grep,Bash");
    // Never inherited from the user's CLI default: the model is always explicit.
    expect(argv).toContain("--model sonnet");
    // Bash is allowed only for the reviewer-state CLI; gh/git are denied outright.
    expect(argv).toContain(`Bash(${process.execPath} ${process.env.REVIEWER_CLI_PATH} report:*)`);
    expect(argv).toContain("Bash(gh:*)");
    expect(argv).toContain("Bash(git:*)");
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(run.argv).not.toContain("Write");

    const prompt = claude.promptOf(0);
    expect(prompt).toContain("SKILL.md");
    expect(prompt).toContain("RUBRIC.md");
    expect(prompt).toContain("untrusted");
    expect(prompt).toContain("NEVER run `gh`");
    // No checkout is configured in the base fixture, so the verification pass
    // must be switched off explicitly rather than left to inference.
    expect(prompt).toContain("VERIFICATION PASS: SKIPPED");
    expect(prompt).toContain("Do NOT emit any findings");
    expect(prompt).not.toContain("VERIFICATION PASS: RUN IT");
  });

  it("uses the incremental flow when an analysis already exists", async () => {
    buildFixture(root); // fixture ships an analysis-set event
    await app.request(`/api/prs/${encodedKey}/analyze`, { method: "POST" });
    await analysisIdle();
    expect(claude.promptOf(0)).toContain("MIGRATION-NOTES.md");
    expect(claude.promptOf(0)).toContain("set-unit");
  });
});

/* --------------------------------------------------------------- triggers */

describe("automatic triggers", () => {
  it("starts an analysis after a successful init", async () => {
    setGhRunner(ghFor([REV1_PATCH]));
    const res = await app.request("/api/prs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: `https://github.com/${key.owner}/${key.repo}/pull/${key.number}` }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).analysisJob.status).toBe("queued");
    await analysisIdle();
    expect(readJob(key, root)!.status).toBe("done");
  });

  it("honors ?analyze=false on init", async () => {
    setGhRunner(ghFor([REV1_PATCH]));
    const res = await app.request("/api/prs?analyze=false", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: `https://github.com/${key.owner}/${key.repo}/pull/${key.number}` }),
    });
    expect((await res.json()).analysisJob).toBeNull();
    expect(readJob(key, root)).toBeNull();
    expect(claude.runs).toHaveLength(0);
  });

  it("re-analyzes on refresh only when the migration produced new hunks", async () => {
    buildFixture(root, DOD_REV1);
    // The next revision edits one line of a wide hunk: it fuzzy-matches, so
    // there is nothing new to classify and no run should start.
    setGhRunner(ghFor([DOD_REV2], "2"));
    const quiet = await app.request(`/api/prs/${encodedKey}/refresh`, { method: "POST" });
    const quietBody = await quiet.json();
    expect(quietBody.report.counts.new).toBe(0);
    expect(quietBody.analysisJob).toBeNull();
    expect(claude.runs).toHaveLength(0);

    // A brand-new file adds unclassified hunks: that does trigger a run.
    const withNewFile =
      DOD_REV2 +
      `diff --git a/src/bar.ts b/src/bar.ts
new file mode 100644
index 0000000..4444444
--- /dev/null
+++ b/src/bar.ts
@@ -0,0 +1,2 @@
+export const bar = 1;
+export const baz = 2;
`;
    setGhRunner(ghFor([withNewFile], "3"));
    const res = await app.request(`/api/prs/${encodedKey}/refresh`, { method: "POST" });
    const body = await res.json();
    expect(body.report.counts.new).toBeGreaterThan(0);
    expect(body.analysisJob.status).toBe("queued");
    await analysisIdle();
  });
});

/* --------------------------------------------------------------- repo path */

describe("POST /repo-path", () => {
  /** meta.headRef is what worktree resolution keys off; fixtures don't set it. */
  const setHeadRef = (headRef: string) => updateMeta(key, { headRef }, root);

  it("accepts a matching git checkout and stores it on meta", async () => {
    buildFixture(root);
    const repo = makeRepo(path.join(root, "checkout"), {
      origin: "git@github.com:acme/widgets.git",
    });
    const res = await app.request(`/api/prs/${encodedKey}/repo-path`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: repo.path }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.warning).toBeUndefined();
    expect(readMeta(key, root).repoPath).toBe(repo.path);
  });

  it("accepts a path inside the checkout, not just its top level", async () => {
    buildFixture(root);
    const repo = makeRepo(path.join(root, "checkout"), {
      origin: "git@github.com:acme/widgets.git",
    });
    const sub = path.join(repo.path, "src", "deep");
    fs.mkdirSync(sub, { recursive: true });
    const res = await app.request(`/api/prs/${encodedKey}/repo-path`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: sub }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).warning).toBeUndefined();
    // Stored verbatim: resolution happens per run, not here.
    expect(readMeta(key, root).repoPath).toBe(sub);
  });

  it("warns but accepts a checkout whose origin is a different repo", async () => {
    buildFixture(root);
    const repo = makeRepo(path.join(root, "other"), {
      origin: "https://github.com/someone/else.git",
    });
    const res = await app.request(`/api/prs/${encodedKey}/repo-path`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: repo.path }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warning).toContain("does not match acme/widgets");
    expect(readMeta(key, root).repoPath).toBe(repo.path);
  });

  it("rejects a missing directory", async () => {
    buildFixture(root);
    const res = await app.request(`/api/prs/${encodedKey}/repo-path`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: path.join(root, "nope") }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("repo_path_missing");
  });

  it("parses owner/repo out of every remote spelling", () => {
    expect(ownerRepoFromRemote("git@github.com:Acme/Widgets.git")).toBe("acme/widgets");
    expect(ownerRepoFromRemote("https://github.com/acme/widgets")).toBe("acme/widgets");
    expect(ownerRepoFromRemote("ssh://git@ghe.corp/acme/widgets.git")).toBe("acme/widgets");
  });

  it("resolves the main checkout to the worktree holding the PR branch", async () => {
    buildFixture(root);
    setHeadRef("feature-x");
    const repo = makeRepo(path.join(root, "checkout"), {
      origin: "git@github.com:acme/widgets.git",
    });
    const wt = addWorktree(repo.path, path.join(root, "wt-feature"), "feature-x");

    const set = await app.request(`/api/prs/${encodedKey}/repo-path`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: repo.path }),
    });
    const setBody = await set.json();
    expect(setBody.checkoutMismatch).toBeNull();
    expect(setBody.warning).toContain("wt-feature");

    const res = await app.request(`/api/prs/${encodedKey}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    await res.text();
    await chatTurnDone(key);
    // The run gets the worktree, not the stored main checkout.
    expect(claude.runs[0].cwd).toBe(fs.realpathSync(wt.path));
    expect(claude.runs[0].argv.join(" ")).toContain(
      `--add-dir ${path.join(root, key.host, key.owner, key.repo, String(key.number))}`,
    );
  });

  it("works when the reader pastes the worktree itself", async () => {
    buildFixture(root);
    setHeadRef("feature-x");
    const repo = makeRepo(path.join(root, "checkout"), {
      origin: "git@github.com:acme/widgets.git",
    });
    const wt = addWorktree(repo.path, path.join(root, "wt-feature"), "feature-x");

    const set = await app.request(`/api/prs/${encodedKey}/repo-path`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: wt.path }),
    });
    expect((await set.json()).checkoutMismatch).toBeNull();

    await app.request(`/api/prs/${encodedKey}/analyze`, { method: "POST" });
    await analysisIdle();
    expect(claude.runs[0].argv.join(" ")).toContain(`--add-dir ${fs.realpathSync(wt.path)}`);
    expect(claude.promptOf(0)).toContain("A local checkout with the PR's branch is available");
    // With a checkout the verification pass is on, and the prompt itself
    // carries the findings schema (not only the skill it points at).
    expect(claude.promptOf(0)).toContain("VERIFICATION PASS: RUN IT");
    expect(claude.promptOf(0)).toContain('"severity": "warning" | "note"');
    expect(claude.promptOf(0)).toContain("`evidence` is REQUIRED and non-empty");
    expect(claude.promptOf(0)).not.toContain("VERIFICATION PASS: SKIPPED");
  });

  it("falls back with checkoutMismatch when no worktree has the PR branch", async () => {
    buildFixture(root);
    setHeadRef("feature-x");
    const repo = makeRepo(path.join(root, "checkout"), {
      origin: "git@github.com:acme/widgets.git",
    });

    const set = await app.request(`/api/prs/${encodedKey}/repo-path`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: repo.path }),
    });
    expect((await set.json()).checkoutMismatch).toEqual({
      checkedOutBranch: "main",
      prHeadRef: "feature-x",
    });

    const detail = await (await app.request(`/api/prs/${encodedKey}`)).json();
    expect(detail.checkoutMismatch).toEqual({
      checkedOutBranch: "main",
      prHeadRef: "feature-x",
    });

    await app.request(`/api/prs/${encodedKey}/analyze`, { method: "POST" });
    await analysisIdle();
    // The run still gets the checkout, but is told not to trust it.
    expect(claude.runs[0].argv.join(" ")).toContain(`--add-dir ${fs.realpathSync(repo.path)}`);
    expect(claude.promptOf(0)).toContain("but it is on branch main");
    // A stale checkout is still a checkout: SKILL.md tells the run to treat
    // what it reads as possibly stale, which is a weaker claim, not no claim.
    expect(claude.promptOf(0)).toContain("VERIFICATION PASS: RUN IT");
    expect(claude.promptOf(0)).toContain("may not match the diff");
  });

  it("picks up a worktree created after the path was set", async () => {
    buildFixture(root);
    setHeadRef("feature-x");
    const repo = makeRepo(path.join(root, "checkout"), {
      origin: "git@github.com:acme/widgets.git",
    });
    await app.request(`/api/prs/${encodedKey}/repo-path`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: repo.path }),
    });
    // `wt feature-x` happens only now — resolution is per run, so it counts.
    const wt = addWorktree(repo.path, path.join(root, "wt-feature"), "feature-x");

    await app.request(`/api/prs/${encodedKey}/analyze`, { method: "POST" });
    await analysisIdle();
    expect(claude.runs[0].argv.join(" ")).toContain(`--add-dir ${fs.realpathSync(wt.path)}`);
  });

  it("runs without a checkout when the stored path was deleted", async () => {
    buildFixture(root);
    setHeadRef("feature-x");
    const repo = makeRepo(path.join(root, "checkout"), {
      origin: "git@github.com:acme/widgets.git",
    });
    await app.request(`/api/prs/${encodedKey}/repo-path`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: repo.path }),
    });
    fs.rmSync(repo.path, { recursive: true, force: true });

    // Neither the detail endpoint nor the run may fail over a deleted dir.
    const detail = await app.request(`/api/prs/${encodedKey}`);
    expect(detail.status).toBe(200);

    await app.request(`/api/prs/${encodedKey}/analyze`, { method: "POST" });
    await analysisIdle();
    expect(readJob(key, root)!.status).toBe("done");
    expect(claude.runs[0].cwd).toBe(path.join(root, key.host, key.owner, key.repo, String(key.number)));
    expect(claude.runs[0].argv.join(" ")).not.toContain(repo.path);
    expect(claude.promptOf(0)).toContain("local checkout is unavailable");
    expect(claude.promptOf(0)).toContain("VERIFICATION PASS: SKIPPED");
    expect(claude.promptOf(0)).toContain("Never");
    expect(claude.promptOf(0)).toContain("speculate a finding from the diff alone");
  });
});

/* --------------------------------------------------------- ref resolution */

describe("chat reference resolution", () => {
  it("resolves each reference kind into a context block", async () => {
    const { hunkIds } = buildFixture(root);

    const unit = resolveRefs(key, [{ kind: "unit", id: "unit-1" }], root);
    expect(unit).toContain("Unit unit-1 — Widget logic");
    expect(unit).toContain("new2");

    const hunk = resolveRefs(key, [{ kind: "hunk", id: hunkIds[0] }], root);
    expect(hunk).toContain(hunkIds[0]);
    expect(hunk).toContain("-old2");

    const file = resolveRefs(key, [{ kind: "file", path: "src/foo.ts" }], root);
    expect(file).toContain("File src/foo.ts");
    expect(file).toContain("new11");

    const range = resolveRefs(
      key,
      [{ kind: "line-range", path: "src/foo.ts", start: 1, end: 3, side: "new" }],
      root,
    );
    expect(range).toContain("lines 1-3 (new side)");
    expect(range).toContain("new2");

    const created = await app.request(`/api/prs/${encodedKey}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: "src/foo.ts", line: 2, side: "RIGHT", body: "why this?" }),
    });
    const { comment } = await created.json();
    const commentBlock = resolveRefs(key, [{ kind: "comment", id: comment.id }], root);
    expect(commentBlock).toContain("src/foo.ts:2");
    expect(commentBlock).toContain("why this?");

    // Every block carries the untrusted-data framing.
    expect(unit).toContain("untrusted data");
  });

  it("rejects the whole send when a reference cannot be resolved", async () => {
    buildFixture(root);
    const res = await app.request(`/api/prs/${encodedKey}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "look", refs: [{ kind: "unit", id: "ghost" }] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("unresolvable_ref");
    expect(body.detail).toContain("ghost");
    // Nothing was persisted and no run was started.
    expect(fs.existsSync(chatPath(key, root))).toBe(false);
    expect(claude.runs).toHaveLength(0);
  });

  it("rejects a line range that lies outside every hunk", () => {
    buildFixture(root);
    try {
      resolveRefs(key, [{ kind: "line-range", path: "src/foo.ts", start: 400, end: 402 }], root);
      throw new Error("expected resolveRefs to throw");
    } catch (err) {
      expect((err as HttpError).message).toBe("unresolvable_ref");
      expect((err as HttpError).detail).toMatch(/not inside any hunk/);
    }
  });
});

/* -------------------------------------------------------------------- chat */

describe("chat", () => {
  it("streams delta/tool/done and persists the transcript", async () => {
    buildFixture(root);
    claude.restore();
    claude = fakeClaude({
      lines: scriptedRun({
        sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        tools: [{ name: "Read", input: { file_path: "/tmp/files.json" } }],
        text: "The rounding change is the risky part.",
      }),
    });
    claude.install();

    const res = await app.request(`/api/prs/${encodedKey}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "What should I look at first?" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    await chatTurnDone(key);

    expect(body).toContain("event: tool");
    expect(body).toContain('"name":"Read"');
    expect(body).toContain("event: delta");
    expect(body).toContain("event: done");
    expect(body).toContain("rounding change");
    expect(body.indexOf("event: tool")).toBeLessThan(body.indexOf("event: done"));

    const chat = JSON.parse(fs.readFileSync(chatPath(key, root), "utf8"));
    expect(chat.sessionId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(chat.messages).toHaveLength(2);
    expect(chat.messages[0]).toMatchObject({ role: "user", text: "What should I look at first?" });
    expect(chat.messages[1]).toMatchObject({
      role: "assistant",
      text: "The rounding change is the risky part.",
    });

    const get = await (await app.request(`/api/prs/${encodedKey}/chat`)).json();
    expect(get.messages).toHaveLength(2);
    expect(get.sessionId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(get.busy).toBe(false);
  });

  it("starts a session on the first turn and resumes it afterwards, read-only throughout", async () => {
    buildFixture(root);
    for (const text of ["first", "second"]) {
      const res = await app.request(`/api/prs/${encodedKey}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      await res.text();
      await chatTurnDone(key);
    }
    const [first, second] = claude.runs;
    expect(first.argv).toContain("--session-id");
    expect(first.argv).not.toContain("--resume");
    expect(second.argv).toContain("--resume");
    expect(second.argv[second.argv.indexOf("--resume") + 1]).toBe(
      "11111111-2222-3333-4444-555555555555",
    );

    const argv = second.argv.join(" ");
    expect(argv).toContain("--tools Read,Glob,Grep,Bash");
    expect(argv).toContain("Write");       // in the deny list
    expect(argv).toContain("Bash(gh:*)");
    expect(argv).toContain("set-analysis:*)");
    expect(argv).toContain("--include-partial-messages");
    const system = second.argv[second.argv.indexOf("--append-system-prompt") + 1];
    expect(system).toContain("READ-ONLY");
    expect(system).toContain("UNTRUSTED DATA");
    expect(system).toContain("draft");
  });

  it("emits an error event and keeps the session when the run fails", async () => {
    buildFixture(root);
    claude.restore();
    claude = fakeClaude({ exitCode: 2, lines: scriptedRun({ isError: true }) });
    claude.install();
    const res = await app.request(`/api/prs/${encodedKey}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    const body = await res.text();
    await chatTurnDone(key);
    expect(body).toContain("event: error");
    const chat = JSON.parse(fs.readFileSync(chatPath(key, root), "utf8"));
    expect(chat.messages).toHaveLength(1); // the user's message survives
  });

  it("persists the answer even when the client disconnects mid-stream", async () => {
    buildFixture(root);
    const controller = new AbortController();
    const res = await app.request(`/api/prs/${encodedKey}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "bye" }),
      signal: controller.signal,
    });
    await res.body?.cancel();
    controller.abort();
    await chatTurnDone(key);
    const chat = JSON.parse(fs.readFileSync(chatPath(key, root), "utf8"));
    expect(chat.messages).toHaveLength(2);
    expect(chat.messages[1].role).toBe("assistant");
  });

  it("DELETE clears the transcript and the session id", async () => {
    buildFixture(root);
    const res = await app.request(`/api/prs/${encodedKey}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    await res.text();
    await chatTurnDone(key);
    expect(fs.existsSync(chatPath(key, root))).toBe(true);

    const del = await app.request(`/api/prs/${encodedKey}/chat`, { method: "DELETE" });
    expect((await del.json()).ok).toBe(true);
    const after = await (await app.request(`/api/prs/${encodedKey}/chat`)).json();
    expect(after.messages).toHaveLength(0);
    expect(after.sessionId).toBeNull();
  });

  it("prepends resolved references to the prompt it sends", async () => {
    const { hunkIds } = buildFixture(root);
    const res = await app.request(`/api/prs/${encodedKey}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "is this right?", refs: [{ kind: "hunk", id: hunkIds[0] }] }),
    });
    await res.text();
    await chatTurnDone(key);
    const prompt = claude.promptOf(0);
    expect(prompt).toContain("REFERENCED CONTEXT");
    expect(prompt).toContain(hunkIds[0]);
    expect(prompt.trimEnd().endsWith("is this right?")).toBe(true);
  });
});

describe("model selection", () => {
  const modelOf = (argv: string[]) => argv[argv.indexOf("--model") + 1];

  const sendChat = async (text: string) => {
    const res = await app.request(`/api/prs/${encodedKey}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    await res.text();
    await chatTurnDone(key);
  };

  it("passes --model on every spawn, defaulting to sonnet for both kinds of run", async () => {
    buildFixture(root);
    await app.request(`/api/prs/${encodedKey}/analyze`, { method: "POST" });
    await analysisIdle();
    await sendChat("hi");

    expect(claude.runs).toHaveLength(2);
    for (const run of claude.runs) {
      expect(run.argv).toContain("--model");
      expect(modelOf(run.argv)).toBe("sonnet");
    }
  });

  it("uses the repo's configured models, analysis and chat independently", async () => {
    buildFixture(root);
    writeRepoConfig(
      { host: key.host, owner: key.owner, repo: key.repo },
      { analysisModel: "opus", chatModel: "haiku" },
      root,
    );

    await app.request(`/api/prs/${encodedKey}/analyze`, { method: "POST" });
    await analysisIdle();
    await sendChat("hi");

    expect(modelOf(claude.runs[0].argv)).toBe("opus");
    expect(modelOf(claude.runs[1].argv)).toBe("haiku");
  });

  it("POST /chat/model pins the session, and the next spawn uses it", async () => {
    buildFixture(root);
    await sendChat("first");
    expect(modelOf(claude.runs[0].argv)).toBe("sonnet");

    const res = await app.request(`/api/prs/${encodedKey}/chat/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "opus" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      model: "opus",
      sessionModel: "opus",
      configuredModel: "sonnet",
      // `claude --resume` accepts a different --model, so the transcript stays.
      restartedSession: false,
    });

    await sendChat("second");
    const second = claude.runs[1];
    expect(modelOf(second.argv)).toBe("opus");
    // ...on the same session: switching models does not start a new one.
    expect(second.argv).toContain("--resume");

    const state = await (await app.request(`/api/prs/${encodedKey}/chat`)).json();
    expect(state.model).toBe("opus");
    expect(state.sessionModel).toBe("opus");
    expect(state.messages).toHaveLength(4);
  });

  it("GET /chat reports the layered default until the session pins one", async () => {
    buildFixture(root);
    writeRepoConfig(
      { host: key.host, owner: key.owner, repo: key.repo },
      { chatModel: "haiku" },
      root,
    );
    const before = await (await app.request(`/api/prs/${encodedKey}/chat`)).json();
    expect(before).toMatchObject({
      model: "haiku",
      configuredModel: "haiku",
      configuredModelSource: "repo",
      sessionModel: null,
    });

    await app.request(`/api/prs/${encodedKey}/chat/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "opus" }),
    });
    const pinned = await (await app.request(`/api/prs/${encodedKey}/chat`)).json();
    expect(pinned).toMatchObject({ model: "opus", configuredModel: "haiku", sessionModel: "opus" });

    // null un-pins and falls back to the repo setting again.
    await app.request(`/api/prs/${encodedKey}/chat/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: null }),
    });
    const cleared = await (await app.request(`/api/prs/${encodedKey}/chat`)).json();
    expect(cleared).toMatchObject({ model: "haiku", sessionModel: null });
  });

  it("400s on an unknown model, a missing field or an extra key", async () => {
    buildFixture(root);
    const post = (body: unknown) =>
      app.request(`/api/prs/${encodedKey}/chat/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    for (const bad of [
      { model: "gpt-5" },
      { model: "claude-sonnet-5" },
      {},
      { model: "sonnet", restart: true },
    ]) {
      expect((await post(bad)).status).toBe(400);
    }
    // ...and the session is untouched by a rejected write.
    const state = await (await app.request(`/api/prs/${encodedKey}/chat`)).json();
    expect(state.sessionModel).toBeNull();
  });

  it("clearing the conversation drops the pin along with the transcript", async () => {
    buildFixture(root);
    await app.request(`/api/prs/${encodedKey}/chat/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "opus" }),
    });
    await app.request(`/api/prs/${encodedKey}/chat`, { method: "DELETE" });
    const after = await (await app.request(`/api/prs/${encodedKey}/chat`)).json();
    expect(after.sessionModel).toBeNull();
    expect(after.model).toBe("sonnet");
  });
});

/* ------------------------------------------------------------------ events */

describe("GET /events", () => {
  it("streams job transitions as they happen", async () => {
    buildFixture(root);
    const res = await app.request(`/api/prs/${encodedKey}/events`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const first = decoder.decode((await reader.read()).value);
    expect(first).toContain("event: analysis-job");
    expect(first).toContain('"job":null');

    await app.request(`/api/prs/${encodedKey}/analyze`, { method: "POST" });
    // Transitions can coalesce into one chunk, so keep everything seen so far.
    let seen = first;
    while (!seen.includes('"status":"done"')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      seen += decoder.decode(chunk.value);
    }
    expect(seen).toContain('"status":"queued"');
    expect(seen).toContain('"status":"running"');
    expect(seen).toContain('"status":"done"');
    await reader.cancel();
    await analysisIdle();
  });
});

/* -------------------------------------------------------- revision writing */

describe("state fixture sanity", () => {
  it("keeps analysis events foldable into state", () => {
    buildFixture(root);
    const files = parseDiff(REV1_PATCH);
    writeRevision(key, 1, REV1_PATCH, files, {}, root);
    const state = appendEvents(
      key,
      [
        { type: "analysis-started", revision: 1 },
        { type: "analysis-finished", revision: 1, status: "done" },
      ],
      root,
    );
    expect(state.analysisRun).toMatchObject({ revision: 1, status: "done" });
    expect(toRevisionFiles(files)[0].path).toBe("src/foo.ts");
  });
});
