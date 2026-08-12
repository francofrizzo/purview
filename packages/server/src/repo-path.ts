import fs from "node:fs";
import path from "node:path";
import { keyToString, updateMeta, type PrKey } from "@reviewer/core";
import { HttpError } from "./http-error.js";

/**
 * Pointing a PR at a local checkout is optional and only ever improves
 * quality (Claude gets the surrounding code as an extra readable root), so
 * validation is deliberately lopsided: a missing directory is rejected, but a
 * remote that doesn't look like this PR's repo is only a warning — worktrees,
 * forks, mirrors and SSH/HTTPS spellings are all legitimate.
 *
 * `.git/config` is parsed rather than shelling out to `git`, which keeps this
 * synchronous, dependency-free and testable without a real repository.
 */

export interface RepoPathResult {
  ok: true;
  path: string;
  warning?: string;
}

/** `git@github.com:acme/widgets.git` / `https://github.com/acme/widgets` -> `acme/widgets` */
export function ownerRepoFromRemote(url: string): string | undefined {
  const cleaned = url.trim().replace(/\.git$/, "");
  const scp = cleaned.match(/^[^@]+@[^:]+:(.+)$/);
  const target = scp ? scp[1] : cleaned.replace(/^[a-z+]+:\/\/[^/]+\//i, "");
  const parts = target.split("/").filter(Boolean);
  if (parts.length < 2) return undefined;
  return parts.slice(-2).join("/").toLowerCase();
}

/** Resolves `.git`, following the `gitdir:` pointer a worktree/submodule uses. */
function gitDir(repoPath: string): string | undefined {
  const dotGit = path.join(repoPath, ".git");
  if (!fs.existsSync(dotGit)) return undefined;
  const stat = fs.statSync(dotGit);
  if (stat.isDirectory()) return dotGit;
  const pointer = fs.readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m);
  if (!pointer) return undefined;
  const target = pointer[1].trim();
  return path.isAbsolute(target) ? target : path.resolve(repoPath, target);
}

function originUrl(gitDirPath: string): string | undefined {
  // A worktree's gitdir points at `<main>/.git/worktrees/<name>`, whose config
  // has no remotes — the real one is two levels up.
  const candidates = [
    path.join(gitDirPath, "config"),
    path.join(gitDirPath, "..", "..", "config"),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    const section = text.match(/\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/);
    const url = section?.[1].match(/^\s*url\s*=\s*(.+)$/m);
    if (url) return url[1].trim();
  }
  return undefined;
}

export function setRepoPath(
  key: PrKey,
  input: unknown,
  root: string,
): RepoPathResult {
  if (typeof input !== "string" || input.trim() === "") {
    throw new HttpError(400, "invalid_body", "Body must include { path: string }");
  }
  const repoPath = path.resolve(input.trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
    throw new HttpError(400, "repo_path_missing", `No such directory: ${repoPath}`);
  }

  const gd = gitDir(repoPath);
  let warning: string | undefined;
  if (!gd) {
    warning = `${repoPath} is not a git repository (no .git); it will still be readable, but it may not be the PR's code.`;
  } else {
    const remote = originUrl(gd);
    const expected = `${key.owner}/${key.repo}`.toLowerCase();
    const actual = remote ? ownerRepoFromRemote(remote) : undefined;
    if (!remote) {
      warning = `${repoPath} has no \`origin\` remote, so it could not be matched against ${keyToString(key)}.`;
    } else if (actual !== expected) {
      warning =
        `\`origin\` of ${repoPath} is ${remote} (${actual ?? "unrecognized"}), ` +
        `which does not match ${expected}. Accepted anyway — check it is the right checkout.`;
    }
  }

  updateMeta(key, { repoPath }, root);
  return { ok: true, path: repoPath, warning };
}
