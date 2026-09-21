import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Real git repositories in a temp dir. Worktree resolution is entirely about
 * git's actual behavior (`.git` as a file, the porcelain format, where the
 * common dir lives), so faking git here would only test our own assumptions.
 */

export function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  }).trim();
}

export interface Repo {
  path: string;
  headSha: string;
  branch: string;
}

/** A repo with one commit on `branch` and an `origin` remote. */
export function makeRepo(
  dir: string,
  opts: { origin?: string; branch?: string } = {},
): Repo {
  const branch = opts.branch ?? "main";
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "-q", "-b", branch], dir);
  fs.writeFileSync(path.join(dir, "pricing.ts"), "export const rate = 0.1;\n");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "initial"], dir);
  if (opts.origin !== false && opts.origin !== undefined) {
    git(["remote", "add", "origin", opts.origin], dir);
  }
  return { path: dir, headSha: git(["rev-parse", "HEAD"], dir), branch };
}

/** `git worktree add -b <branch> <dir>` — the wt-style layout. */
export function addWorktree(repo: string, dir: string, branch: string): Repo {
  git(["worktree", "add", "-q", "-b", branch, dir], repo);
  return { path: dir, headSha: git(["rev-parse", "HEAD"], dir), branch };
}

/** A worktree with a detached HEAD (no branch), for sha-based matching. */
export function addDetachedWorktree(repo: string, dir: string, sha: string): Repo {
  git(["worktree", "add", "-q", "--detach", dir, sha], repo);
  return { path: dir, headSha: git(["rev-parse", "HEAD"], dir), branch: "" };
}

export interface PrRemote {
  path: string;
  baseSha: string;
  headSha: string;
}

/**
 * A stand-in for the GitHub repo: its path ends in `acme/widgets`, so it
 * matches that owner/repo as a remote URL. The PR's head is reachable only as
 * `refs/pull/<number>/head` (the branch is deleted), the way a fork's or a
 * stacked PR's head is — so a clone does not have it until it fetches that ref.
 *
 * The PR modifies pricing.ts, renames legacy.ts -> modern.ts and adds added.ts.
 */
export function makePrRemote(dir: string, number: number): PrRemote {
  const repo = makeRepo(dir);
  fs.writeFileSync(path.join(dir, "legacy.ts"), "export const legacy = true;\n");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "base"], dir);
  const baseSha = git(["rev-parse", "HEAD"], dir);

  git(["checkout", "-q", "-b", "pr-branch"], dir);
  fs.writeFileSync(path.join(dir, "pricing.ts"), "export const rate = 0.2;\n");
  git(["mv", "legacy.ts", "modern.ts"], dir);
  fs.writeFileSync(path.join(dir, "added.ts"), "export const added = 1;\n");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "pr"], dir);
  const headSha = git(["rev-parse", "HEAD"], dir);
  git(["update-ref", `refs/pull/${number}/head`, headSha], dir);
  git(["checkout", "-q", repo.branch], dir);
  git(["branch", "-q", "-D", "pr-branch"], dir);
  return { path: dir, baseSha, headSha };
}

/** A new commit on top of the PR head, published as `refs/pull/<number>/head`. */
export function pushPrHead(remote: string, number: number, content: string): string {
  const head = git(["rev-parse", `refs/pull/${number}/head`], remote);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], remote);
  git(["checkout", "-q", "--detach", head], remote);
  fs.writeFileSync(path.join(remote, "pricing.ts"), content);
  git(["commit", "-q", "-am", "pr update"], remote);
  const sha = git(["rev-parse", "HEAD"], remote);
  git(["update-ref", `refs/pull/${number}/head`, sha], remote);
  git(["checkout", "-q", branch], remote);
  return sha;
}

/** `git clone` — the reader's own copy of the repo. */
export function cloneRepo(from: string, dir: string, opts: { bare?: boolean } = {}): string {
  // --no-local: a plain local clone copies the whole object store, unreachable
  // PR commits included; a real clone only has what its refs reach.
  git(["clone", "-q", "--no-local", ...(opts.bare ? ["--bare"] : []), from, dir], path.dirname(dir));
  return dir;
}
