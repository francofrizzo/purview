import fs from "node:fs";
import {
  deleteRepoState,
  keyToString,
  listPrs,
  repoDir,
  repoKeyToString,
  stateRoot,
  type PrKey,
  type RepoKey,
} from "@reviewer/core";
import { isBusy } from "./analysis.js";
import { chatBusy } from "./chat-session.js";
import { readComments } from "./comments.js";
import { HttpError } from "./http-error.js";
import { removeRepoCheckouts } from "./pr-checkout.js";
import { forgetWatchStatus } from "./review-watch.js";
import { clearStalenessCache } from "./staleness.js";

/**
 * Removing a repo from Purview: the destructive counterpart of archiving it.
 * Everything Purview keeps locally for the repo goes — its PR directories,
 * `repo.json` and the local rubric/chat overlays, and its managed checkouts
 * (unregistered from the reader's clones one by one, see pr-checkout.ts).
 * Nothing on GitHub changes: pushed comments stay in their pending reviews.
 */

export interface RepoRemovalSummary {
  /** `host/owner/repo` */
  repo: string;
  prCount: number;
  /** local-only drafts: lost with the repo */
  draftComments: number;
  /** in a pending review on GitHub: they stay there, only Purview's copy goes */
  pushedComments: number;
  /** PRs that block removal right now, and why */
  busy: { key: string; reason: "analysis" | "chat" }[];
}

export interface RepoRemovalResult extends RepoRemovalSummary {
  /** managed checkout directories that were removed */
  removedCheckouts: string[];
}

function prsOf(repo: RepoKey, root: string): PrKey[] {
  return listPrs(root).filter(
    (k) => k.host === repo.host && k.owner === repo.owner && k.repo === repo.repo,
  );
}

function assertTracked(repo: RepoKey, root: string): void {
  if (!fs.existsSync(repoDir(repo, root))) {
    throw new HttpError(404, "not_found", `${repoKeyToString(repo)} is not tracked in Purview`);
  }
}

/**
 * What removing the repo would lose, and whether it can be removed now. What
 * the confirm UI shows, and what `DELETE /api/repos/:rkey` checks and reports.
 */
export function repoRemovalSummary(repo: RepoKey, root = stateRoot()): RepoRemovalSummary {
  assertTracked(repo, root);
  const prs = prsOf(repo, root);
  let draftComments = 0;
  let pushedComments = 0;
  const busy: RepoRemovalSummary["busy"] = [];
  for (const key of prs) {
    try {
      for (const c of readComments(key, root)) {
        if (c.status === "draft") draftComments++;
        else if (c.status === "pushed") pushedComments++;
      }
    } catch {
      /* an unreadable comments file still goes; it just can't be counted */
    }
    if (isBusy(key)) busy.push({ key: keyToString(key), reason: "analysis" });
    else if (chatBusy(key)) busy.push({ key: keyToString(key), reason: "chat" });
  }
  return { repo: repoKeyToString(repo), prCount: prs.length, draftComments, pushedComments, busy };
}

/**
 * Delete all local state for the repo. Refuses (409) while any of its PRs has
 * a queued or running analysis or a streaming chat reply — either would write
 * into a directory that is about to disappear, and the analysis holds a
 * managed checkout open.
 *
 * The state directory goes first, synchronously, right after the busy check:
 * from then on nothing can start a run for these PRs (they no longer exist),
 * so the slower checkout cleanup that follows cannot race a new one.
 */
export async function removeRepo(repo: RepoKey, root = stateRoot()): Promise<RepoRemovalResult> {
  const summary = repoRemovalSummary(repo, root);
  if (summary.busy.length > 0) {
    const first = summary.busy[0];
    throw new HttpError(
      409,
      "repo_busy",
      first.reason === "analysis"
        ? `An analysis is queued or running for ${first.key}; cancel it or let it finish first.`
        : `A chat reply is still streaming for ${first.key}; wait for it to finish.`,
    );
  }
  const prs = prsOf(repo, root);
  deleteRepoState(repo, root);
  for (const key of prs) clearStalenessCache(key, root);
  forgetWatchStatus(repoKeyToString(repo));
  const removedCheckouts = await removeRepoCheckouts(
    repo,
    prs.map((k) => k.number),
    root,
  );
  return { ...summary, removedCheckouts };
}
