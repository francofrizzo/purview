import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { serve, type ServerType } from "@hono/node-server";
import {
  checkoutsRoot,
  keyToString,
  listPrs,
  listRepos,
  prCheckoutPath,
  repoDir,
  setGhRunner,
  writeMeta,
  writeRepoConfig,
  type PrKey,
} from "@reviewer/core";
import { createApp } from "../src/app.js";
import { analysisIdle } from "../src/analysis.js";
import { readComments, writeComments } from "../src/comments.js";
import { ensurePrCheckout, removeRepoCheckouts } from "../src/pr-checkout.js";
import { listWorktrees } from "../src/worktree.js";
import { buildFixture, key } from "./fixtures.js";
import { fakeClaude, scriptedRun, type FakeClaude } from "./fake-claude.js";
import { addWorktree, cloneRepo, git, makePrRemote, type PrRemote } from "./git-fixtures.js";

/**
 * Removing a repo from Purview: its state dir and managed checkouts go, the
 * reader's clones keep everything but Purview's own worktree entries, other
 * repos are untouched, and nothing happens while one of its PRs is busy.
 */

const repo = { host: key.host, owner: key.owner, repo: key.repo };
const rkey = `${repo.host}/${repo.owner}/${repo.repo}`;
const encodedRepo = encodeURIComponent(rkey);
const encodedKey = encodeURIComponent(keyToString(key));
const otherRepoPr: PrKey = { host: "github.com", owner: "acme", repo: "gadgets", number: 3 };
const cliPath = fileURLToPath(new URL("../../core/dist/cli.js", import.meta.url));
const execFileAsync = promisify(execFile);

let root: string;
let app: ReturnType<typeof createApp>;
let claude: FakeClaude;

function track(k: PrKey) {
  writeMeta(
    k,
    {
      host: k.host,
      owner: k.owner,
      repo: k.repo,
      number: k.number,
      url: `https://github.com/${k.owner}/${k.repo}/pull/${k.number}`,
      createdAt: new Date().toISOString(),
    },
    root,
  );
}

async function addComment(body: string, status: "draft" | "pushed" | "submitted" = "draft") {
  const res = await app.request(`/api/prs/${encodedKey}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file: "src/foo.ts", line: 2, side: "RIGHT", body }),
  });
  expect(res.status).toBe(201);
  const { id } = (await res.json()).comment as { id: string };
  if (status !== "draft") {
    writeComments(
      key,
      readComments(key, root).map((c) =>
        c.id === id
          ? {
              ...c,
              status,
              githubCommentId: 1,
              ...(status === "submitted" ? { submittedAt: "2026-01-01T00:00:00Z" } : {}),
            }
          : c,
      ),
      root,
    );
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-repo-removal-"));
  process.env.PURVIEW_SKILL_DIR = path.join(root, "skills");
  fs.mkdirSync(process.env.PURVIEW_SKILL_DIR, { recursive: true });
  buildFixture(root);
  writeRepoConfig(repo, { watchReviews: true }, root);
  track(otherRepoPr);
  app = createApp({ stateDir: root, webDist: path.join(root, "__no-web-dist__"), reviewRequestRefresh: false });
  claude = fakeClaude({ lines: scriptedRun() });
  claude.install();
});

afterEach(async () => {
  await analysisIdle();
  claude.restore();
  setGhRunner(null);
  delete process.env.PURVIEW_SKILL_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("GET /api/repos/:rkey/removal", () => {
  it("counts PRs and unsubmitted comments, drafts and pushed apart", async () => {
    track({ ...key, number: 8 });
    await addComment("one");
    await addComment("two");
    await addComment("in a pending review", "pushed");
    await addComment("public already", "submitted");
    const res = await app.request(`/api/repos/${encodedRepo}/removal`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      repo: rkey,
      prCount: 2,
      draftComments: 2,
      pushedComments: 1,
      busy: [],
    });
  });

  it("404s for an untracked repo", async () => {
    const res = await app.request(`/api/repos/${encodeURIComponent("github.com/acme/nope")}/removal`);
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/repos/:rkey", () => {
  it("deletes the repo's state dir and nothing else, and reports what went", async () => {
    await addComment("draft");
    const res = await app.request(`/api/repos/${encodedRepo}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      repo: rkey,
      prCount: 1,
      draftComments: 1,
      pushedComments: 0,
      removedCheckouts: [],
    });
    expect(fs.existsSync(repoDir(repo, root))).toBe(false);
    // The sibling repo of the same owner, and its PR, are untouched.
    expect(listPrs(root)).toEqual([otherRepoPr]);
    expect(listRepos(root).map((r) => r.repo)).toEqual(["gadgets"]);
    expect(fs.existsSync(path.join(root, "github.com", "acme"))).toBe(true);

    const prs = await (await app.request("/api/prs")).json();
    expect(prs.prs.map((p: { key: string }) => p.key)).toEqual([keyToString(otherRepoPr)]);
    expect((await app.request(`/api/prs/${encodedKey}`)).status).toBe(404);
  });

  it("drops an owner dir that the removal left empty", async () => {
    fs.rmSync(repoDir({ ...otherRepoPr }, root), { recursive: true });
    const res = await app.request(`/api/repos/${encodedRepo}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(root, "github.com"))).toBe(false);
    expect(fs.existsSync(root)).toBe(true);
  });

  it("refuses while an analysis is queued or running, and deletes nothing", async () => {
    claude.restore();
    claude = fakeClaude({ hang: true, lines: scriptedRun() });
    claude.install();
    expect((await app.request(`/api/prs/${encodedKey}/analyze`, { method: "POST" })).status).toBe(200);

    const summary = await (await app.request(`/api/repos/${encodedRepo}/removal`)).json();
    expect(summary.busy).toEqual([{ key: keyToString(key), reason: "analysis" }]);
    const res = await app.request(`/api/repos/${encodedRepo}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("repo_busy");
    expect(fs.existsSync(repoDir(repo, root))).toBe(true);

    await app.request(`/api/prs/${encodedKey}/analyze`, { method: "DELETE" });
    await analysisIdle();
    expect((await app.request(`/api/repos/${encodedRepo}`, { method: "DELETE" })).status).toBe(200);
  });

  it("404s for an untracked repo", async () => {
    const res = await app.request(`/api/repos/${encodeURIComponent("github.com/acme/nope")}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("is loopback-only, even for a LAN device holding the token", async () => {
    const TOKEN = "t0ken-abcdefghijklmnopqrstuv";
    const lanApp = createApp({
      stateDir: root,
      webDist: path.join(root, "__no-web-dist__"),
      port: 4779,
      lan: { token: TOKEN, hosts: ["192.168.1.24"] },
      reviewRequestRefresh: false,
    });
    const res = await lanApp.request(`http://192.168.1.24:4779/api/repos/${encodedRepo}`, {
      method: "DELETE",
      headers: { Cookie: `purview_token=${TOKEN}`, Origin: "http://192.168.1.24:4779" },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("loopback_only");
    expect(fs.existsSync(repoDir(repo, root))).toBe(true);
  });

  it("is refused to the review chat", async () => {
    const res = await app.request(`/api/repos/${encodedRepo}`, {
      method: "DELETE",
      headers: { "X-Purview-Actor": "chat" },
    });
    expect(res.status).toBe(403);
    expect(fs.existsSync(repoDir(repo, root))).toBe(true);
  });
});

/* ---------------------------------------------------- managed checkouts */

describe("removing a repo's managed checkouts", () => {
  let work: string;
  let remote: PrRemote;

  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "purview-repo-removal-work-"));
    remote = makePrRemote(path.join(work, "gh", "acme", "widgets"), key.number);
  });
  afterEach(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  const ensure = (repoPath: string, k: PrKey) =>
    ensurePrCheckout(k, {
      repoPath,
      headSha: remote.headSha,
      mergeBase: remote.baseSha,
      baseSha: remote.baseSha,
      root,
    });

  it("removes each checkout through git, leaving the reader's clone and its other worktrees", async () => {
    const user = cloneRepo(remote.path, path.join(work, "user"));
    const mine = addWorktree(user, path.join(work, "wt-mine"), "mine");
    // A worktree of the reader's that is missing right now: a global
    // `git worktree prune` would forget it; the removal must not.
    const offline = addWorktree(user, path.join(work, "wt-offline"), "offline");
    fs.rmSync(offline.path, { recursive: true, force: true });
    const listed = () => git(["worktree", "list", "--porcelain"], user);

    // #7 is tracked; #99 is a stray checkout with no PR state at all.
    for (const k of [key, { ...key, number: 99 }]) expect("path" in (await ensure(user, k))).toBe(true);
    // Not a PR checkout: left alone.
    const notes = path.join(checkoutsRoot(root), repo.host, repo.owner, repo.repo, "notes");
    fs.mkdirSync(notes, { recursive: true });

    const res = await app.request(`/api/repos/${encodedRepo}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.removedCheckouts.sort()).toEqual(
      [prCheckoutPath(key, root), prCheckoutPath({ ...key, number: 99 }, root)].sort(),
    );
    expect(fs.existsSync(prCheckoutPath(key, root))).toBe(false);
    expect(fs.existsSync(notes)).toBe(true);

    const paths = listWorktrees(user).map((w) => w.path);
    expect(paths).toContain(fs.realpathSync(user));
    expect(paths).toContain(fs.realpathSync(mine.path));
    expect(paths.some((p) => p.includes(checkoutsRoot(root)) || p.includes("checkouts"))).toBe(false);
    expect(listed()).toContain(offline.path);
    expect(fs.readFileSync(path.join(user, "pricing.ts"), "utf8")).toContain("0.1");
  });

  it("the helper tidies empty checkout dirs and is a no-op without any", async () => {
    expect(await removeRepoCheckouts(repo, [key.number], root)).toEqual([]);
    const user = cloneRepo(remote.path, path.join(work, "user"));
    expect("path" in (await ensure(user, key))).toBe(true);
    expect(await removeRepoCheckouts(repo, [key.number], root)).toEqual([prCheckoutPath(key, root)]);
    expect(fs.existsSync(path.join(checkoutsRoot(root), repo.host))).toBe(false);
    expect(listWorktrees(user).map((w) => w.path)).toEqual([fs.realpathSync(user)]);
  });
});

/* ------------------------------------------------------- CLI -> server */

describe("reviewer-state remove-repo", () => {
  let server: ServerType | undefined;
  let port = 0;
  let live: ReturnType<typeof createApp> | undefined;

  async function listen(): Promise<void> {
    await new Promise<void>((resolve) => {
      server = serve(
        {
          fetch: (r) =>
            (live ??= createApp({
              stateDir: root,
              webDist: path.join(root, "__no-web-dist__"),
              port,
              reviewRequestRefresh: false,
            })).fetch(r),
          port: 0,
          hostname: "127.0.0.1",
        },
        (info: AddressInfo) => {
          port = info.port;
          resolve();
        },
      );
    });
  }

  afterEach(async () => {
    live = undefined;
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function cli(args: string[], env: Record<string, string> = {}) {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
        env: {
          ...process.env,
          PURVIEW_STATE_DIR: root,
          PURVIEW_PORT: String(port),
          PURVIEW_ACTOR: "",
          PURVIEW_SERVER_URL: "",
          ...env,
        },
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code: number; stdout: string; stderr: string };
      return { code: e.code, stdout: e.stdout, stderr: e.stderr };
    }
  }

  it("needs --yes, says what would go, and then removes the repo", async () => {
    await listen();
    await addComment("draft");
    const dry = await cli(["remove-repo", rkey]);
    expect(dry.code).toBe(1);
    expect(dry.stderr).toContain(`all local state for ${rkey}: 1 PR, 1 draft comment`);
    expect(dry.stderr).toContain("--yes");
    expect(fs.existsSync(repoDir(repo, root))).toBe(true);

    const res = await cli(["remove-repo", "acme/widgets", "--yes"]);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain(`Removed ${rkey} from Purview: 1 PR, 1 draft comment.`);
    expect(res.stdout).toContain("Nothing on GitHub was changed.");
    expect(fs.existsSync(repoDir(repo, root))).toBe(false);
    expect(listPrs(root)).toEqual([otherRepoPr]);
  });

  it("is refused inside the review chat", async () => {
    await listen();
    const res = await cli(["remove-repo", rkey, "--yes"], { PURVIEW_ACTOR: "chat" });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("403");
    expect(fs.existsSync(repoDir(repo, root))).toBe(true);
  });
});
