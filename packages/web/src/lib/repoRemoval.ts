/**
 * Copy and the typed-name check for "remove from Purview…". Pure, so the
 * wording the reader confirms against is unit-tested rather than eyeballed.
 */

import type { RepoRemovalSummary } from "../api/types";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The name the reader types to confirm: `owner/repo`, as the list shows it. */
export function removalConfirmName(repo: { owner: string; repo: string }): string {
  return `${repo.owner}/${repo.repo}`;
}

/** Whether the typed text names the repo (surrounding space and case ignored). */
export function removalConfirmMatches(typed: string, repo: { owner: string; repo: string }): boolean {
  return typed.trim().toLowerCase() === removalConfirmName(repo).toLowerCase();
}

/**
 * What goes, in the order a reader weighs it. Pushed comments are called out
 * separately: they live in a pending review on GitHub and stay there — only
 * Purview's copy (and its link to them) is lost.
 */
export function removalLossLines(s: Pick<RepoRemovalSummary, "prCount" | "draftComments" | "pushedComments">): string[] {
  const lines = [
    `${plural(s.prCount, "tracked PR")}, with their analyses, viewed marks and chats.`,
    s.draftComments > 0
      ? `${plural(s.draftComments, "draft comment")} not yet pushed — these exist only here.`
      : "No unpushed draft comments.",
  ];
  if (s.pushedComments > 0) {
    lines.push(
      `${plural(s.pushedComments, "pushed comment")} in a pending review: ${s.pushedComments === 1 ? "it stays" : "they stay"} on GitHub, but Purview forgets ${s.pushedComments === 1 ? "it" : "them"}.`,
    );
  }
  lines.push("This repo's local settings and Purview's own checkouts of its PRs.");
  return lines;
}

/** Why the server would refuse right now, or null when nothing blocks it. */
export function removalBlockedWhy(s: Pick<RepoRemovalSummary, "busy">): string | null {
  const first = s.busy[0];
  if (!first) return null;
  const pr = `#${first.key.split("/").pop()}`;
  return first.reason === "analysis"
    ? `An analysis is running for ${pr}; cancel it or let it finish first.`
    : `A chat reply is still streaming for ${pr}; wait for it to finish.`;
}
