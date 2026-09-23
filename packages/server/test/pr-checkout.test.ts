import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkoutsRoot,
  keyToString,
  listPrs,
  prCheckoutPath,
  prDir,
  setGhRunner,
  updateMeta,
  writeMeta,
  type PrKey,
} from "@reviewer/core";
import { createApp } from "../src/app.js";
import { analysisIdle, checkoutNote } from "../src/analysis.js";
import { chatTurnDone } from "../src/chat-session.js";
import { readChat, writeChat } from "../src/chat.js";
import { writeConfig } from "../src/config.js";
import { dropWorktreeEntry, ensurePrCheckout, pruneCheckouts } from "../src/pr-checkout.js";
import { listWorktrees } from "../src/worktree.js";
import { buildFixture, key } from "./fixtures.js";
import { fakeClaude, type FakeClaude } from "./fake-claude.js";
import {
  addWorktree,
  cloneRepo,
  git,
  makePrRemote,
  pushPrHead,
  type PrRemote,
} from "./git-fixtures.js";

/**
 * Managed checkouts against real git: a temp "GitHub" remote exposing the PR
 * head only as refs/pull/<n>/head, and the reader's own clone of it. The state
 * root and the repos live in separate temp dirs, so "never touches anything
 * outside checkoutsRoot" is observable.
 */

let root: string;
let work: string;
let remote: PrRemote;

const real = (p: string) => fs.realpathSync(p);
const managedPath = (k: PrKey = key) => prCheckoutPath(k, root);
const headOf = (dir: string) => git(["rev-parse", "HEAD"], dir);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-checkout-state-"));
  work = fs.mkdtempSync(path.join(os.tmpdir(), "purview-checkout-work-"));
  remote = makePrRemote(path.join(work, "gh", "acme", "widgets"), key.number);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

function ensure(repoPath: string, headSha = remote.headSha, k: PrKey = key) {
  return ensurePrCheckout(k, {
    repoPath,
    headSha,
    mergeBase: remote.baseSha,
    baseSha: remote.baseSha,
    root,
  });
}

describe("ensurePrCheckout", () => {
  it("fetches refs/pull/<n>/head and creates a detached worktree at the head", async () => {
    const user = cloneRepo(remote.path, path.join(work, "user"));
    // The clone never saw the PR head: only the fetch can bring it in.
    expect(() => git(["cat-file", "-e", `${remote.headSha}^{commit}`], user)).toThrow();

    const res = await ensure(user);
    expect(res).toEqual({ path: real(managedPath()), headSha: remote.headSha, baseRef: remote.baseSha });
    expect(headOf(managedPath())).toBe(remote.headSha);
    expect(fs.readFileSync(path.join(managedPath(), "pricing.ts"), "utf8")).toContain("0.2");
    const entry = listWorktrees(user).find((w) => w.path === real(managedPath()));
    expect(entry?.detached).toBe(true);
    // Lives under checkouts/, never inside the PR state dir.
    expect(managedPath().startsWith(checkoutsRoot(root))).toBe(true);
    expect(managedPath().startsWith(prDir(key, root))).toBe(false);
  });

  it("reuses the worktree and moves it to a new head on refresh", async () => {
    const user = cloneRepo(remote.path, path.join(work, "user"));
    await ensure(user);
    const before = listWorktrees(user).length;

    const next = pushPrHead(remote.path, key.number, "export const rate = 0.3;\n");
    const res = await ensure(user, next);
    expect("path" in res && res.path).toBe(real(managedPath()));
    expect(headOf(managedPath())).toBe(next);
    expect(fs.readFileSync(path.join(managedPath(), "pricing.ts"), "utf8")).toContain("0.3");
    expect(listWorktrees(user)).toHaveLength(before);
  });

  it("works when the configured path is a worktree of a bare repo, and the bare repo itself", async () => {
    const bare = cloneRepo(remote.path, path.join(work, "core.git"), { bare: true });
    git(["worktree", "add", "-q", path.join(work, "core-main"), "main"], bare);

    const viaWorktree = await ensure(path.join(work, "core-main"));
    expect(viaWorktree).toMatchObject({ path: real(managedPath()), headSha: remote.headSha });
    expect(listWorktrees(bare).map((w) => w.path)).toContain(real(managedPath()));

    // Same repo reached through the bare dir: the existing worktree is reused.
    const viaBare = await ensure(bare);
    expect(viaBare).toMatchObject({ path: real(managedPath()) });
    expect(headOf(managedPath())).toBe(remote.headSha);
  });

  it("never uses or touches the reader's own worktree holding the PR branch", async () => {
    const user = cloneRepo(remote.path, path.join(work, "user"));
    git(["fetch", "-q", "origin", `refs/pull/${key.number}/head:feature`], user);
    const mine = addWorktree(user, path.join(work, "wt-feature"), "feature-local");
    git(["checkout", "-q", "feature"], mine.path);
    fs.writeFileSync(path.join(mine.path, "pricing.ts"), "// my local edit\n");

    const res = await ensure(user);
    expect("path" in res && res.path).toBe(real(managedPath()));
    expect(real(managedPath())).not.toBe(real(mine.path));
    // The reader's tree keeps its branch and its uncommitted edit.
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], mine.path)).toBe("feature");
    expect(fs.readFileSync(path.join(mine.path, "pricing.ts"), "utf8")).toBe("// my local edit\n");
    // And the managed tree has the real head content, not the edit.
    expect(fs.readFileSync(path.join(managedPath(), "pricing.ts"), "utf8")).toContain("0.2");
  });

  it("refuses a repository with no remote pointing at the PR's owner/repo", async () => {
    const user = cloneRepo(remote.path, path.join(work, "user"));
    git(["remote", "set-url", "origin", "https://github.com/someone/else.git"], user);
    const res = await ensure(user);
    expect(res).toEqual({ error: expect.stringContaining("points at acme/widgets") });
    expect(fs.existsSync(managedPath())).toBe(false);
  });

  it("uses a non-origin remote that matches (fork layout)", async () => {
    const user = cloneRepo(remote.path, path.join(work, "user"));
    git(["remote", "rename", "origin", "upstream"], user);
    git(["remote", "add", "origin", "https://github.com/me/fork.git"], user);
    const res = await ensure(user);
    expect(res).toMatchObject({ path: real(managedPath()), headSha: remote.headSha });
  });

  it("errors when the head commit cannot be found even after fetching", async () => {
    const user = cloneRepo(remote.path, path.join(work, "user"));
    const res = await ensure(user, "0".repeat(40));
    expect(res).toEqual({ error: expect.stringContaining("not in") });
  });

  it("serializes concurrent calls: two ensures, one worktree", async () => {
    const user = cloneRepo(remote.path, path.join(work, "user"));
    const [a, b] = await Promise.all([ensure(user), ensure(user)]);
    expect(a).toEqual(b);
    expect("path" in a).toBe(true);
    const managed = listWorktrees(user).filter((w) => w.path.startsWith(real(checkoutsRoot(root))));
    expect(managed).toHaveLength(1);
  });

  it("recreates its own deleted checkout without forgetting the reader's missing worktrees", async () => {
    const user = cloneRepo(remote.path, path.join(work, "user"));
    // A worktree of the reader's whose folder is gone (an unmounted drive):
    // registered but missing. A global `git worktree prune` would drop it.
    const offline = addWorktree(user, path.join(work, "wt-offline"), "offline");
    fs.rmSync(offline.path, { recursive: true, force: true });
    const listed = () => git(["worktree", "list", "--porcelain"], user);
    expect(listed()).toContain(offline.path);

    await ensure(user);
    // Purview's own checkout goes missing the same way, then gets recreated.
    fs.rmSync(managedPath(), { recursive: true, force: true });
    const res = await ensure(user);
    expect("path" in res && res.path).toBe(real(managedPath()));
    expect(headOf(managedPath())).toBe(remote.headSha);
    expect(listed()).toContain(offline.path);
  });

  it("rebuilds a stale directory that is not a registered worktree", async () => {
    const user = cloneRepo(remote.path, path.join(work, "user"));
    fs.mkdirSync(managedPath(), { recursive: true });
    fs.writeFileSync(path.join(managedPath(), "junk.txt"), "left over\n");

    const res = await ensure(user);
    expect("path" in res).toBe(true);
    expect(fs.existsSync(path.join(managedPath(), "junk.txt"))).toBe(false);
    expect(headOf(managedPath())).toBe(remote.headSha);
  });
});

/* ------------------------------------------------------------------ prune */

describe("pruneCheckouts", () => {
  const pr = (number: number): PrKey => ({ ...key, number });
  const track = (k: PrKey, extra: Record<string, unknown> = {}) =>
    writeMeta(
      k,
      {
        host: k.host,
        owner: k.owner,
        repo: k.repo,
        number: k.number,
        url: `https://github.com/${k.owner}/${k.repo}/pull/${k.number}`,
        createdAt: new Date().toISOString(),
        archived: false,
        ...extra,
      },
      root,
    );

  it("removes only untracked, archived, merged and closed PRs' checkouts", async () => {
    const user = cloneRepo(remote.path, path.join(work, "user"));
    track(pr(7), { prState: "open" });
    track(pr(8), { archived: true });
    track(pr(9), { prState: "merged" });
    track(pr(10), { prState: "closed" });
    // pr(11) is never tracked.
    for (const n of [7, 8, 9, 10, 11]) {
      expect("path" in (await ensure(user, remote.headSha, pr(n)))).toBe(true);
    }
    // Things prune must never touch: a non-PR entry inside checkouts/, the
    // PR state dirs, and the reader's repo.
    const notes = path.join(checkoutsRoot(root), key.host, key.owner, key.repo, "notes");
    fs.mkdirSync(notes, { recursive: true });
    fs.writeFileSync(path.join(notes, "keep.txt"), "x");

    const removed = await pruneCheckouts(root);

    expect(removed.sort()).toEqual([8, 9, 10, 11].map((n) => managedPath(pr(n))).sort());
    expect(fs.existsSync(managedPath(pr(7)))).toBe(true);
    for (const n of [8, 9, 10, 11]) expect(fs.existsSync(managedPath(pr(n)))).toBe(false);
    expect(fs.existsSync(path.join(notes, "keep.txt"))).toBe(true);
    for (const n of [7, 8, 9, 10]) expect(fs.existsSync(prDir(pr(n), root))).toBe(true);
    // git forgot the removed worktrees; the reader's clone is intact.
    const paths = listWorktrees(user).map((w) => w.path);
    expect(paths).toEqual([real(user), real(managedPath(pr(7)))]);
    expect(fs.readFileSync(path.join(user, "pricing.ts"), "utf8")).toContain("0.1");
  });

  it("drops only its own worktree entry when git cannot remove the checkout", async () => {
    const user = cloneRepo(remote.path, path.join(work, "user"));
    const offline = addWorktree(user, path.join(work, "wt-offline"), "offline");
    fs.rmSync(offline.path, { recursive: true, force: true });
    const listed = () => git(["worktree", "list", "--porcelain"], user);

    track(pr(7), { prState: "closed" });
    expect("path" in (await ensure(user, remote.headSha, pr(7)))).toBe(true);
    const managed = real(managedPath(pr(7)));
    // Break the checkout's link so `git worktree remove` fails and the rm
    // fallback runs, while the admin entry in the reader's repo remains.
    fs.writeFileSync(path.join(managed, ".git"), "gitdir: /nowhere\n");
    const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], user);

    await pruneCheckouts(root);
    // Leaving the dir unresolvable means removeCheckout found no common dir;
    // clean up via the targeted helper and check it spares the reader's entry.
    dropWorktreeEntry(common, managed);
    expect(fs.existsSync(managed)).toBe(false);
    expect(listed()).not.toContain(managed);
    expect(listed()).toContain(offline.path);
  });

  it("falls back to deleting a checkout git no longer knows", async () => {
    const orphan = managedPath({ ...key, number: 99 });
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, "file.txt"), "x");
    expect(await pruneCheckouts(root)).toEqual([orphan]);
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it("is a no-op without a checkouts dir", async () => {
    expect(await pruneCheckouts(root)).toEqual([]);
  });
});

describe("state walkers", () => {
  it("listPrs never treats checkouts/ as a host", async () => {
    buildFixture(root);
    const user = cloneRepo(remote.path, path.join(work, "user"));
    await ensure(user);
    // A PR-shaped meta.json four levels under checkouts/ must still be ignored.
    const decoy = path.join(checkoutsRoot(root), "h", "o", "1");
    fs.mkdirSync(decoy, { recursive: true });
    fs.writeFileSync(path.join(decoy, "meta.json"), "{}");
    expect(listPrs(root).map(keyToString)).toEqual([keyToString(key)]);
  });
});

/* ------------------------------------------------- analysis + chat wiring */

describe("runs with a managed checkout", () => {
  let app: ReturnType<typeof createApp>;
  let claude: FakeClaude;
  const encodedKey = encodeURIComponent(keyToString(key));
  // cliCommand() is one executable: a wrapper generated beside the CLI script.
const cli = () => path.join(path.dirname(process.env.REVIEWER_CLI_PATH!), "reviewer-state");

  beforeEach(() => {
    process.env.REVIEWER_SKILL_DIR = path.join(root, "skills");
    process.env.REVIEWER_CLI_PATH = path.join(root, "cli.js");
    fs.mkdirSync(process.env.REVIEWER_SKILL_DIR, { recursive: true });
    claude = fakeClaude();
    claude.install();
    setGhRunner(() => "{}");
    app = createApp({ stateDir: root, webDist: path.join(root, "__no-web-dist__"), analysisTimeoutMs: 10_000 });
    buildFixture(root, undefined, {
      baseSha: remote.baseSha,
      headSha: remote.headSha,
      mergeBase: remote.baseSha,
    });
  });

  afterEach(async () => {
    await analysisIdle();
    claude.restore();
    setGhRunner(null);
    delete process.env.REVIEWER_SKILL_DIR;
    delete process.env.REVIEWER_CLI_PATH;
  });

  async function analyze() {
    await app.request(`/api/prs/${encodedKey}/analyze`, { method: "POST" });
    await analysisIdle();
  }

  async function chat(text: string) {
    const res = await app.request(`/api/prs/${encodedKey}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    await res.text();
    await chatTurnDone(key);
  }

  it("hands the analysis the exact head checkout, with the base-file hint", async () => {
    const user = cloneRepo(remote.path, path.join(work, "user"));
    updateMeta(key, { repoPath: user, headRef: "feature" }, root);
    await analyze();

    const managed = real(managedPath());
    const prompt = claude.promptOf(0);
    expect(prompt).toContain(
      `An exact checkout of the PR head (${remote.headSha.slice(0, 12)}) is at ${managed}. ` +
        "It is the code as this PR leaves it — read from it freely, never modify it. " +
        `To see a file as it was before the PR, run \`${cli()} base-file ${keyToString(key)} <path>\`.`,
    );
    expect(prompt).toContain("VERIFICATION PASS: RUN IT");
    const argv = claude.runs[0].argv.join(" ");
    expect(argv).toContain(`--add-dir ${managed}`);
    expect(claude.runs[0].argv).toContain(`Bash(${cli()} base-file:*)`);
    expect(claude.runs[0].argv).toContain("Bash(git:*)"); // git itself stays denied
    // The analysis cwd stays the state dir.
    expect(claude.runs[0].cwd).toBe(prDir(key, root));
    expect(headOf(managed)).toBe(remote.headSha);
  });

  it("falls back to the old resolution when the remote is the wrong repo", async () => {
    const user = cloneRepo(remote.path, path.join(work, "user"));
    git(["remote", "set-url", "origin", "https://github.com/someone/else.git"], user);
    updateMeta(key, { repoPath: user }, root);
    await analyze();

    const prompt = claude.promptOf(0);
    expect(prompt).not.toContain("An exact checkout");
    expect(prompt).toContain(`A local checkout with the PR's branch is available at ${real(user)}`);
    expect(fs.existsSync(managedPath())).toBe(false);
  });

  it("skips managed checkouts entirely when the config switch is off", async () => {
    writeConfig({ managedCheckouts: false }, root);
    const user = cloneRepo(remote.path, path.join(work, "user"));
    updateMeta(key, { repoPath: user }, root);
    await analyze();

    expect(claude.promptOf(0)).not.toContain("An exact checkout");
    expect(fs.existsSync(managedPath())).toBe(false);
  });

  it("gives the chat the managed checkout as its cwd and names it in the system prompt", async () => {
    const user = cloneRepo(remote.path, path.join(work, "user"));
    updateMeta(key, { repoPath: user }, root);
    await chat("hi");

    const run = claude.runs[0];
    expect(run.cwd).toBe(real(managedPath()));
    expect(run.argv.join(" ")).toContain("An exact checkout of the PR head");
    expect(run.argv).toContain(`Bash(${cli()} base-file:*)`);
    expect(readChat(key, root).sessionCwd).toBe(real(managedPath()));
  });

  it("hands the chat to the terminal from the managed checkout, with the base-file hint", async () => {
    const user = cloneRepo(remote.path, path.join(work, "user"));
    updateMeta(key, { repoPath: user }, root);
    await chat("hi");

    const res = await app.request(`/api/prs/${encodedKey}/chat/handoff`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    const managed = real(managedPath());
    expect(body.cwd).toBe(managed);
    expect(body.command.startsWith(`cd '${managed}' && claude --resume ${body.sessionId} --fork-session`)).toBe(true);

    const context = fs.readFileSync(body.contextPath, "utf8");
    expect(context).toContain(
      `An exact checkout of the PR head (${remote.headSha.slice(0, 12)}) is at ${managed}.`,
    );
    expect(context).toContain(`\`${cli()} base-file ${keyToString(key)} <path>\``);
    expect(context).toContain("Review units:");
    expect(context).not.toContain("HARD RULES");
    // Nothing was fetched or moved to build it.
    expect(headOf(managed)).toBe(remote.headSha);
  });

  describe("chat session cwd", () => {
    it("resumes when the cwd is unchanged", async () => {
      await chat("first");
      await chat("second");
      expect(claude.runs[0].argv).toContain("--session-id");
      expect(claude.runs[1].argv).toContain("--resume");
      expect(claude.promptOf(1)).not.toContain("CONVERSATION SO FAR");
    });

    it("starts a fresh session and replays when the cwd changed", async () => {
      await chat("first"); // no repo configured: cwd is the state dir
      expect(readChat(key, root).sessionCwd).toBe(prDir(key, root));

      const user = cloneRepo(remote.path, path.join(work, "user"));
      updateMeta(key, { repoPath: user }, root);
      await chat("second");

      const second = claude.runs[1];
      expect(second.cwd).toBe(real(managedPath()));
      expect(second.argv).not.toContain("--resume");
      expect(second.argv).toContain("--session-id");
      expect(claude.promptOf(1)).toContain("CONVERSATION SO FAR");
      expect(claude.promptOf(1)).toContain("You: first");
      expect(readChat(key, root).sessionCwd).toBe(real(managedPath()));
    });

    it("treats a chat saved before sessionCwd existed as unknown, and replays once", async () => {
      // A pre-upgrade chat.json: a live session id, no sessionCwd field.
      writeChat(
        key,
        {
          sessionId: "c6501064-896c-4508-ae1c-42e0b21150e2",
          messages: [
            { role: "user", text: "old question", ts: new Date().toISOString() },
            { role: "assistant", text: "old answer", ts: new Date().toISOString() },
          ],
          model: null,
        },
        root,
      );
      await chat("new question");
      const first = claude.runs[0];
      expect(first.argv).not.toContain("--resume");
      expect(first.argv[first.argv.indexOf("--session-id") + 1]).not.toBe(
        "c6501064-896c-4508-ae1c-42e0b21150e2",
      );
      expect(claude.promptOf(0)).toContain("You: old question");
      expect(claude.promptOf(0)).toContain("Assistant: old answer");

      // From here on the cwd is known, so the next turn resumes.
      await chat("follow-up");
      expect(claude.runs[1].argv).toContain("--resume");
    });
  });
});

describe("checkoutNote", () => {
  it("names the managed checkout and the base-file command", () => {
    const note = checkoutNote(
      { path: "/co/7", resolvedWorktree: true, managed: { headSha: "a".repeat(40) } },
      "a".repeat(40),
      key,
    );
    expect(note).toContain(`An exact checkout of the PR head (${"a".repeat(12)}) is at /co/7.`);
    expect(note).toContain(`base-file ${keyToString(key)} <path>`);
  });

  it("attributes each sha to its own ref on a mismatched checkout", () => {
    const note = checkoutNote(
      {
        path: "/src/widgets",
        resolvedWorktree: false,
        mismatch: { checkedOutBranch: "main", prHeadRef: "feature-x", checkedOutSha: "c".repeat(40) },
      },
      "a".repeat(40),
      key,
    );
    expect(note).toContain(
      `it is on branch main at ${"c".repeat(12)} while the PR head is feature-x at ${"a".repeat(12)}`,
    );
  });

  it("names a detached checkout by its own sha, not the PR head", () => {
    const note = checkoutNote(
      {
        path: "/src/widgets",
        resolvedWorktree: false,
        mismatch: { checkedOutBranch: `detached at ${"c".repeat(12)}`, prHeadRef: "feature-x" },
      },
      "a".repeat(40),
    );
    expect(note).toContain(`it is detached at ${"c".repeat(12)} while the PR head is feature-x at ${"a".repeat(12)}`);
  });
});
