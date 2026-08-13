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
