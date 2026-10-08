/**
 * The PR's reviews and conversation comments, the way the summary strip reads
 * them: one chronological timeline, and each reviewer's standing verdict (the
 * reviewers box GitHub shows beside a PR).
 *
 * Pure functions only.
 */

import type { RemoteAuthor, RemoteConversationComment, RemoteReview } from "../api/types";
import { botKey, cleanRemoteBody, type ThreadFilters } from "./threads";

export type TimelineEntry =
  | { kind: "review"; id: string; at: string; author: RemoteAuthor; isMine: boolean; review: RemoteReview }
  | { kind: "comment"; id: string; at: string; author: RemoteAuthor; isMine: boolean; comment: RemoteConversationComment };

/**
 * Do the thread filters hide this author? The same rule as threads: AI
 * reviewers as a whole, or one by one. The reader's own words never hide.
 */
export function isAuthorHidden(author: RemoteAuthor, isMine: boolean, filters: ThreadFilters): boolean {
  if (isMine || !author.bot) return false;
  return !filters.showAiReviewers || filters.hiddenBots.includes(botKey(author.login));
}

export interface Timeline {
  /** oldest first */
  entries: TimelineEntry[];
  /** entries the filters hid */
  hidden: number;
}

/** Reviews and conversation comments merged into one list, oldest first. */
export function buildTimeline(
  reviews: readonly RemoteReview[] = [],
  conversation: readonly RemoteConversationComment[] = [],
  filters?: ThreadFilters,
): Timeline {
  const all: TimelineEntry[] = [
    ...reviews.map(
      (review): TimelineEntry => ({
        kind: "review",
        id: review.id,
        at: review.submittedAt,
        author: review.author,
        isMine: review.isMine,
        review,
      }),
    ),
    ...conversation.map(
      (comment): TimelineEntry => ({
        kind: "comment",
        id: comment.id,
        at: comment.createdAt,
        author: comment.author,
        isMine: comment.isMine,
        comment,
      }),
    ),
  ];
  // Stable: a review and a comment at the same instant keep reviews first.
  all.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const entries = filters ? all.filter((e) => !isAuthorHidden(e.author, e.isMine, filters)) : all;
  return { entries, hidden: all.length - entries.length };
}

/** What an entry has to say once GitHub's invisible bookkeeping is gone; "" for nothing. */
export function entryBody(entry: TimelineEntry): string {
  return cleanRemoteBody(entry.kind === "review" ? entry.review.body : entry.comment.body);
}

export type Verdict = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";

export interface ReviewerVerdict {
  author: RemoteAuthor;
  isMine: boolean;
  verdict: Verdict;
  /** when the review that set the verdict was submitted */
  at: string;
}

/**
 * Each reviewer's standing verdict, as GitHub's reviewers box has it: an
 * approval or a change request stands until the same reviewer gives another
 * one (a later plain comment does not undo it); a dismissal clears it. Someone
 * who only ever commented shows as such — except a bot, whose comment-only
 * reviews are its routine output, not a stance. The PR's author is left out
 * (their reviews are replies to threads).
 *
 * Ordered by when each verdict was given, oldest first.
 */
export function latestVerdicts(
  reviews: readonly RemoteReview[] = [],
  opts: { prAuthor?: string; filters?: ThreadFilters } = {},
): ReviewerVerdict[] {
  const prAuthor = opts.prAuthor?.toLowerCase();
  const sorted = [...reviews].sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : 0));
  const by = new Map<string, ReviewerVerdict>();
  for (const r of sorted) {
    const key = botKey(r.author.login);
    if (prAuthor && key === botKey(prAuthor)) continue;
    if (opts.filters && isAuthorHidden(r.author, r.isMine, opts.filters)) continue;
    const cur = by.get(key);
    if (r.state === "COMMENTED") {
      if (!cur) by.set(key, { author: r.author, isMine: r.isMine, verdict: "COMMENTED", at: r.submittedAt });
      continue;
    }
    by.set(key, { author: r.author, isMine: r.isMine, verdict: r.state, at: r.submittedAt });
  }
  return [...by.values()]
    .filter((v) => !(v.author.bot && v.verdict === "COMMENTED"))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** "approved", "requested changes"… — the verb a timeline line uses. */
export function verdictVerb(state: Verdict): string {
  switch (state) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "requested changes";
    case "DISMISSED":
      return "review dismissed";
    default:
      return "commented";
  }
}

/** "maria approved · bob requested changes" — the cluster's tooltip. */
export function verdictsTitle(verdicts: readonly ReviewerVerdict[]): string {
  return verdicts
    .map((v) => `${v.isMine ? "you" : v.author.bot ? (v.author.botName ?? v.author.login) : v.author.login} ${verdictVerb(v.verdict)}`)
    .join(" · ");
}
