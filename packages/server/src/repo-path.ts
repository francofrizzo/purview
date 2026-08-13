import fs from "node:fs";
import path from "node:path";
import {
  keyToString,
  loadState,
  readMeta,
  updateMeta,
  type PrKey,
} from "@reviewer/core";
import { HttpError } from "./http-error.js";
import { originUrl, repoToplevel, resolveCheckout } from "./worktree.js";

/**
 * Pointing a PR at a local checkout is optional and only ever improves
 * quality (Claude gets the surrounding code as an extra readable root), so
 * validation is deliberately lopsided: a missing directory is rejected, but a
 * remote that doesn't look like this PR's repo is only a warning — worktrees,
 * forks, mirrors and SSH/HTTPS spellings are all legitimate.
 *
 * Any path *inside* a checkout is accepted (git resolves it to the top level),
 * including a worktree, whose `.git` is a file rather than a directory.
 * The path is stored verbatim: which worktree it means is decided per run.
 */

export interface RepoPathResult {
  ok: true;
  path: string;
  warning?: string;
  checkoutMismatch?: { checkedOutBranch: string; prHeadRef: string };
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

/** Head ref + head sha of the PR as currently known locally. */
export function prHead(key: PrKey, root: string): { headRef?: string; headSha?: string } {
  const meta = readMeta(key, root);
  const state = loadState(key, root);
  const current = state.revisions.find((r) => r.revision === state.currentRevision);
  return { headRef: meta.headRef, headSha: current?.headSha };
}

export function setRepoPath(key: PrKey, input: unknown, root: string): RepoPathResult {
  if (typeof input !== "string" || input.trim() === "") {
    throw new HttpError(400, "invalid_body", "Body must include { path: string }");
  }
  const repoPath = path.resolve(input.trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
    throw new HttpError(400, "repo_path_missing", `No such directory: ${repoPath}`);
  }

  const top = repoToplevel(repoPath);
  let warning: string | undefined;
  if (!top) {
    warning = `${repoPath} is not a git repository; it will still be readable, but it may not be the PR's code.`;
  } else {
    const remote = originUrl(top);
    const expected = `${key.owner}/${key.repo}`.toLowerCase();
    const actual = remote ? ownerRepoFromRemote(remote) : undefined;
    if (!remote) {
      warning = `${top} has no \`origin\` remote, so it could not be matched against ${keyToString(key)}.`;
    } else if (actual !== expected) {
      warning =
        `\`origin\` of ${top} is ${remote} (${actual ?? "unrecognized"}), ` +
        `which does not match ${expected}. Accepted anyway — check it is the right checkout.`;
    }
  }

  updateMeta(key, { repoPath }, root);

  // Report which checkout this path resolves to *right now*, so the reader
  // finds out immediately if no worktree has the PR's branch — even though the
  // real resolution happens again at run time.
  const resolution = resolveCheckout(repoPath, prHead(key, root));
  if (resolution.resolvedWorktree && resolution.path) {
    warning =
      (warning ? warning + " " : "") +
      `Runs will use the worktree at ${resolution.path}, which has the PR's branch checked out.`;
  }
  return { ok: true, path: repoPath, warning, checkoutMismatch: resolution.mismatch };
}
