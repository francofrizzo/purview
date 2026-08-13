import { execFileSync } from "node:child_process";
import fs from "node:fs";

/**
 * Git checkout resolution.
 *
 * The reader stores one path; what that path *means* changes over time. In a
 * worktree-per-branch workflow the PR's code lives in a sibling worktree that
 * may not have existed when the path was set — so the stored value is treated
 * as "a way into this repository", and the checkout actually handed to Claude
 * is resolved fresh on every run.
 *
 * Everything here is best-effort: a repo that has been deleted, moved or
 * de-gitted must degrade to "no local checkout", never to a failed run.
 */

export type GitRunner = (args: string[], cwd: string) => string;

const defaultRunner: GitRunner = (args, cwd) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });

let runner: GitRunner = defaultRunner;

/** Swap the `git` runner (tests may prefer real repos; this is for failure injection). */
export function setGitRunner(next: GitRunner | null): void {
  runner = next ?? defaultRunner;
}

function git(args: string[], cwd: string): string | undefined {
  try {
    return runner(args, cwd).trim();
  } catch {
    return undefined;
  }
}

/**
 * The top of the working tree containing `p` — works from any subdirectory,
 * and works in a worktree, where `.git` is a *file* rather than a directory.
 */
export function repoToplevel(p: string): string | undefined {
  if (!fs.existsSync(p)) return undefined;
  return git(["-C", p, "rev-parse", "--show-toplevel"], p);
}

/** Shared git dir of the whole repo — identical across all of its worktrees. */
export function repoCommonDir(p: string): string | undefined {
  const dir = git(["-C", p, "rev-parse", "--path-format=absolute", "--git-common-dir"], p);
  // --path-format landed in git 2.31; fall back to the relative form.
  if (dir) return dir;
  return git(["-C", p, "rev-parse", "--git-common-dir"], p);
}

export function originUrl(p: string): string | undefined {
  return git(["-C", p, "remote", "get-url", "origin"], p);
}

export interface WorktreeEntry {
  path: string;
  head?: string;
  /** short branch name, absent for a detached HEAD */
  branch?: string;
  detached: boolean;
  bare: boolean;
}

/** `git worktree list --porcelain`, parsed. Empty when git can't answer. */
export function listWorktrees(p: string): WorktreeEntry[] {
  const out = git(["-C", p, "worktree", "list", "--porcelain"], p);
  if (!out) return [];
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: trimmed.slice("worktree ".length), detached: false, bare: false };
    } else if (!current) {
      continue;
    } else if (trimmed.startsWith("HEAD ")) {
      current.head = trimmed.slice("HEAD ".length);
    } else if (trimmed.startsWith("branch ")) {
      current.branch = trimmed.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (trimmed === "detached") {
      current.detached = true;
    } else if (trimmed === "bare") {
      current.bare = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}

export interface CheckoutResolution {
  /** the directory to hand Claude, or undefined when there is no usable one */
  path?: string;
  /** true when `path` is a different worktree than the stored one */
  resolvedWorktree: boolean;
  /**
   * Set when no worktree has the PR's head checked out. The reader still gets
   * the stored path (better than nothing), but every consumer is expected to
   * say out loud that the code may not match the diff.
   */
  mismatch?: { checkedOutBranch: string; prHeadRef: string };
  /** set when the stored path is unusable (deleted, no longer a repo) */
  error?: string;
}

/**
 * Pick the checkout for a run:
 *   1. no stored path            -> nothing;
 *   2. path gone / not a repo    -> nothing, with an error to warn about;
 *   3. a worktree whose branch is the PR's head ref  -> that worktree;
 *   4. a worktree whose HEAD is the revision's headSha (covers a detached
 *      checkout of the PR, and a branch renamed on GitHub) -> that worktree;
 *   5. otherwise                 -> the stored checkout, flagged as a mismatch.
 */
export function resolveCheckout(
  storedPath: string | undefined,
  pr: { headRef?: string; headSha?: string },
): CheckoutResolution {
  if (!storedPath) return { resolvedWorktree: false };
  if (!fs.existsSync(storedPath)) {
    return {
      resolvedWorktree: false,
      error: `configured checkout ${storedPath} no longer exists`,
    };
  }
  const top = repoToplevel(storedPath);
  if (!top) {
    return {
      resolvedWorktree: false,
      error: `configured checkout ${storedPath} is not a git repository`,
    };
  }

  const worktrees = listWorktrees(top).filter((w) => !w.bare && fs.existsSync(w.path));
  const byBranch = pr.headRef
    ? worktrees.find((w) => w.branch === pr.headRef)
    : undefined;
  const bySha = !byBranch && pr.headSha
    ? worktrees.find((w) => w.head === pr.headSha)
    : undefined;
  const picked = byBranch ?? bySha;

  if (picked) {
    return { path: picked.path, resolvedWorktree: picked.path !== top };
  }

  // No worktree holds the PR's head. Fall back to the stored checkout and say
  // what it is actually sitting on, since that is the thing a reader needs to
  // know when the surrounding code looks wrong.
  const self =
    worktrees.find((w) => w.path === top) ?? listWorktrees(top).find((w) => w.path === top);
  const checkedOutBranch =
    self?.branch ?? (self?.head ? `detached at ${self.head.slice(0, 12)}` : "unknown");
  return {
    path: top,
    resolvedWorktree: false,
    mismatch: pr.headRef
      ? { checkedOutBranch, prHeadRef: pr.headRef }
      : undefined,
  };
}
