import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  checkoutsRoot,
  isPrDirName,
  keyToString,
  prCheckoutPath,
  prExists,
  readMeta,
  stateRoot,
  type Meta,
  type PrKey,
  type RevisionInfo,
} from "@reviewer/core";
import { readConfig } from "./config.js";
import { effectiveRepoPath } from "./repo-config.js";
import { ownerRepoFromRemote } from "./repo-path.js";
import { listWorktrees, resolveCheckout, type CheckoutResolution } from "./worktree.js";

/**
 * Purview-owned PR checkouts.
 *
 * Every analysis run and chat turn gets an exact, detached worktree of the
 * PR's head commit at `~/.purview/checkouts/<host>/<owner>/<repo>/<number>`.
 * The reader's own worktrees are never used or touched: they may carry local
 * edits or sit at another commit, which is precisely the staleness this
 * removes. Detached HEAD means git's "branch already checked out elsewhere"
 * rule can never apply.
 *
 * The configured repo path is only a way to *find* the repository (its common
 * git dir). It may be a normal clone, a worktree, a subdirectory of either, or
 * a bare repo that holds worktrees — `git -C <that path> worktree add` works
 * from all of them.
 *
 * All git work here is async (fetch and checkout can take seconds on a large
 * repo) and never throws: failure is an `{ error }` result the caller degrades
 * on, falling back to `resolveCheckout`.
 */

export type PrCheckoutResult =
  | { path: string; headSha: string; baseRef?: string }
  | { error: string };

export interface EnsurePrCheckoutOptions {
  /** the configured repo path (PR override or repo-level); only used to find the repo */
  repoPath?: string;
  headSha?: string;
  mergeBase?: string;
  baseSha?: string;
  root?: string;
}

/* ------------------------------------------------------------ git (async) */

interface GitOk {
  ok: true;
  out: string;
}
interface GitFail {
  ok: false;
  err: string;
}

const GIT_TIMEOUT_MS = 10 * 60_000;

/**
 * One git invocation. Hooks are switched off (a repo's post-checkout hook must
 * not run `npm install` inside Purview's checkout), LFS smudging is skipped,
 * and a credential prompt can never block the server.
 */
function gitAsync(args: string[], cwd: string): Promise<GitOk | GitFail> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-c", "core.hooksPath=/dev/null", ...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: GIT_TIMEOUT_MS,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_LFS_SKIP_SMUDGE: "1",
        },
      },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || err.message || "git failed").toString().trim().split("\n").pop();
          resolve({ ok: false, err: msg ?? "git failed" });
        } else {
          resolve({ ok: true, out: stdout.toString().trim() });
        }
      },
    );
  });
}

/* ------------------------------------------------------------------ locks */

const locks = new Map<string, Promise<unknown>>();

/**
 * Run `fn` after every earlier holder of `name` has finished. A chat turn and
 * an analysis run on the same PR must not both `checkout` the same worktree;
 * two PRs of one repo must not both `fetch`/`worktree add` into it at once.
 */
function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(name) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  locks.set(name, settled);
  void settled.then(() => {
    if (locks.get(name) === settled) locks.delete(name);
  });
  return next;
}

/* ---------------------------------------------------------------- helpers */

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * The remote whose URL is this PR's owner/repo. `origin` wins a tie, then
 * `upstream` (the usual fork layout), then whichever came first.
 */
async function matchingRemote(repo: string, key: PrKey): Promise<string | undefined> {
  const res = await gitAsync(["-C", repo, "remote", "-v"], repo);
  if (!res.ok) return undefined;
  const expected = `${key.owner}/${key.repo}`.toLowerCase();
  const names: string[] = [];
  for (const line of res.out.split("\n")) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/);
    if (m && ownerRepoFromRemote(m[2]) === expected && !names.includes(m[1])) names.push(m[1]);
  }
  return names.find((n) => n === "origin") ?? names.find((n) => n === "upstream") ?? names[0];
}

async function hasCommit(repo: string, sha: string): Promise<boolean> {
  return (await gitAsync(["-C", repo, "cat-file", "-e", `${sha}^{commit}`], repo)).ok;
}

/* ------------------------------------------------------------------ ensure */

/**
 * Make `prCheckoutPath(key)` an exact detached checkout of `headSha`:
 * fetch the PR head if the commit is missing, create the worktree if absent,
 * move it if it sits elsewhere, and rebuild it if the directory is stale.
 * Serialized per PR.
 */
export function ensurePrCheckout(
  key: PrKey,
  opts: EnsurePrCheckoutOptions,
): Promise<PrCheckoutResult> {
  return withLock(`pr:${keyToString(key)}`, () => ensureUnlocked(key, opts)).catch(
    (err: unknown) => ({ error: `managed checkout failed: ${(err as Error).message}` }),
  );
}

async function ensureUnlocked(key: PrKey, opts: EnsurePrCheckoutOptions): Promise<PrCheckoutResult> {
  const root = opts.root ?? stateRoot();
  const { repoPath, headSha } = opts;
  if (!repoPath) return { error: "no local repository is configured" };
  if (!fs.existsSync(repoPath)) return { error: `configured repository ${repoPath} no longer exists` };
  if (!headSha || !SHA_RE.test(headSha)) {
    return { error: `the PR's head commit is unknown (${headSha ?? "none"})` };
  }

  // Works for a clone, a worktree (its `.git` is a file) and a bare repo.
  const common = await gitAsync(
    ["-C", repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    repoPath,
  );
  if (!common.ok) return { error: `configured path ${repoPath} is not a git repository` };

  const remote = await matchingRemote(repoPath, key);
  if (!remote) {
    return {
      error: `no remote of ${repoPath} points at ${key.owner}/${key.repo}`,
    };
  }

  const target = prCheckoutPath(key, root);
  const baseRef = opts.mergeBase || opts.baseSha || undefined;

  return withLock(`repo:${realpath(common.out)}`, async () => {
    if (!(await hasCommit(repoPath, headSha))) {
      // refs/pull/<n>/head exists for every PR — forks and stacked PRs
      // included — and the merge base, an ancestor, arrives with it.
      const fetched = await gitAsync(
        ["-C", repoPath, "fetch", "--no-tags", "--quiet", remote, `+refs/pull/${key.number}/head`],
        repoPath,
      );
      if (!(await hasCommit(repoPath, headSha))) {
        return {
          error:
            `head commit ${headSha.slice(0, 12)} is not in ${repoPath}` +
            (fetched.ok ? " even after fetching the PR head" : ` and fetching it failed: ${fetched.err}`),
        };
      }
    }

    const targetReal = fs.existsSync(target) ? realpath(target) : undefined;
    const registered = targetReal
      ? listWorktrees(repoPath).find((w) => !w.bare && realpath(w.path) === targetReal)
      : undefined;

    if (registered) {
      if (registered.head !== headSha) {
        // Purview owns this tree and nothing edits it, so --force is safe.
        const moved = await gitAsync(
          ["-C", target, "checkout", "--quiet", "--detach", "--force", headSha],
          target,
        );
        if (!moved.ok) return { error: `could not move ${target} to ${headSha.slice(0, 12)}: ${moved.err}` };
      }
      return { path: targetReal!, headSha, baseRef };
    }

    // Either nothing is there, or a directory git no longer recognises as a
    // worktree of this repo (deleted metadata, an older repo path, a crash
    // mid-add). Start clean; only ever inside checkoutsRoot.
    if (fs.existsSync(target)) {
      if (!isUnder(target, checkoutsRoot(root))) {
        return { error: `refusing to remove ${target}: outside ${checkoutsRoot(root)}` };
      }
      fs.rmSync(target, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // `--force` only overrides the "path is registered but missing" safeguard
    // here (with --detach the "branch checked out elsewhere" rule never
    // applies), so a stale entry for *this* path is reused. Never a global
    // `git worktree prune`: that would also drop the user's own missing
    // worktrees (say, on an unmounted drive) from their repository.
    const added = await gitAsync(
      ["-C", repoPath, "worktree", "add", "--quiet", "--force", "--detach", target, headSha],
      repoPath,
    );
    if (!added.ok) return { error: `git worktree add failed: ${added.err}` };
    return { path: realpath(target), headSha, baseRef };
  });
}

function isUnder(p: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/* ------------------------------------------------- per-run checkout choice */

/**
 * The checkout a run hands Claude: the managed one when it can be made, else
 * exactly the pre-managed behavior (`resolveCheckout`: configured path,
 * sibling worktree, mismatch note). `managedCheckouts: false` in the machine
 * config skips straight to the old behavior.
 */
export async function resolveRunCheckout(
  key: PrKey,
  root: string,
  input: {
    meta?: Meta | null;
    revision?: RevisionInfo;
    label: string;
    /** called right before the (possibly slow) managed checkout starts */
    onPreparing?: () => void;
  },
): Promise<CheckoutResolution> {
  const { meta, revision, label } = input;
  const repoPath = effectiveRepoPath(key, root, { meta: meta ?? null });
  const headSha = revision?.headSha;
  const fallback = () => resolveCheckout(repoPath, { headRef: meta?.headRef, headSha });

  let managed = true;
  try {
    managed = readConfig(root).managedCheckouts;
  } catch {
    /* defaults */
  }
  if (!managed || !repoPath) return fallback();

  input.onPreparing?.();
  const result = await ensurePrCheckout(key, {
    repoPath,
    headSha,
    mergeBase: revision?.mergeBase,
    baseSha: revision?.baseSha,
    root,
  });
  if ("error" in result) {
    console.warn(`[${label}] ${keyToString(key)}: managed checkout unavailable (${result.error}); falling back`);
    return fallback();
  }
  return {
    path: result.path,
    resolvedWorktree: true,
    managed: { headSha: result.headSha, baseRef: result.baseRef },
  };
}

/* ------------------------------------------------------------------ prune */

/**
 * Remove managed checkouts whose PR no longer needs one: untracked, archived,
 * or merged/closed. Walks exactly `checkoutsRoot/<host>/<owner>/<repo>/<n>`
 * and never touches anything outside it. Returns the removed paths.
 */
export async function pruneCheckouts(root = stateRoot()): Promise<string[]> {
  const base = checkoutsRoot(root);
  if (!fs.existsSync(base)) return [];
  const dirs = (p: string) => {
    try {
      return fs
        .readdirSync(p, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.isSymbolicLink())
        .map((d) => d.name);
    } catch {
      return [];
    }
  };
  const removed: string[] = [];
  for (const host of dirs(base)) {
    for (const owner of dirs(path.join(base, host))) {
      for (const repo of dirs(path.join(base, host, owner))) {
        for (const num of dirs(path.join(base, host, owner, repo))) {
          if (!isPrDirName(num)) continue;
          const key: PrKey = { host, owner, repo, number: Number(num) };
          const why = pruneReason(key, root);
          if (!why) continue;
          const dir = prCheckoutPath(key, root);
          await withLock(`pr:${keyToString(key)}`, () => removeCheckout(dir, base));
          if (!fs.existsSync(dir)) {
            console.log(`[checkouts] removed ${dir} (${why})`);
            removed.push(dir);
          }
        }
        removeIfEmpty(path.join(base, host, owner, repo));
      }
      removeIfEmpty(path.join(base, host, owner));
    }
    removeIfEmpty(path.join(base, host));
  }
  return removed;
}

function pruneReason(key: PrKey, root: string): string | undefined {
  if (!prExists(key, root)) return "PR not tracked";
  try {
    const meta = readMeta(key, root);
    if (meta.archived) return "PR archived";
    if (meta.prState === "merged" || meta.prState === "closed") return `PR ${meta.prState}`;
  } catch {
    return undefined; // unreadable meta: leave it alone rather than guess
  }
  return undefined;
}

async function removeCheckout(dir: string, base: string): Promise<void> {
  if (!isUnder(dir, base) || !fs.existsSync(dir)) return;
  const common = await gitAsync(
    ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    dir,
  );
  if (common.ok) {
    const res = await gitAsync(
      ["--git-dir", common.out, "worktree", "remove", "--force", dir],
      path.dirname(dir),
    );
    if (res.ok && !fs.existsSync(dir)) return;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  if (common.ok) dropWorktreeEntry(common.out, dir);
}

/**
 * Remove git's admin entry for exactly one worktree path — the targeted
 * equivalent of `git worktree prune`, which would also forget every other
 * missing worktree in the user's repository. An entry lives at
 * `<common>/worktrees/<name>/` and its `gitdir` file points at
 * `<worktree>/.git`.
 */
export function dropWorktreeEntry(commonDir: string, worktreePath: string): void {
  const adminRoot = path.join(commonDir, "worktrees");
  let names: string[];
  try {
    names = fs.readdirSync(adminRoot);
  } catch {
    return;
  }
  const want = path.resolve(worktreePath, ".git");
  for (const name of names) {
    try {
      const gitdir = fs.readFileSync(path.join(adminRoot, name, "gitdir"), "utf8").trim();
      if (path.resolve(gitdir) === want || safeRealpath(path.dirname(gitdir)) === safeRealpath(worktreePath)) {
        fs.rmSync(path.join(adminRoot, name), { recursive: true, force: true });
      }
    } catch {
      /* not a worktree entry we can read; leave it */
    }
  }
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function removeIfEmpty(dir: string): void {
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    /* already gone or not empty */
  }
}
