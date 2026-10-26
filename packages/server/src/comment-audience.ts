import { cachedViewerLogin, readMeta, stateRoot, writeMeta, type PrKey, type Reviewer } from "@reviewer/core";
import type { CommentAudience } from "./comments.js";
import { readConfig } from "./config.js";

/**
 * Who a new comment on a PR is for. Reviewing someone else's PR, comments are
 * for GitHub; on your own PR (or one your agent opened for you, see
 * `extraAuthors`) there is nobody to review for, so they are notes for the
 * agent that will act on them. The reader can flip either default per PR;
 * the flip is kept on the PR's meta.
 */
export interface CommentAudienceInfo {
  effective: CommentAudience;
  /** the reader's choice for this PR; null = the default by author */
  override: CommentAudience | null;
}

/**
 * Whether a PR counts as one of yours: opened by the viewer, or by a login
 * the reader listed in `extraAuthors` (an agent's bot account). Compared
 * case-insensitively, `[bot]` suffix ignored.
 */
export const authoredByYou = (
  author: string | undefined,
  login: string | null | undefined,
  extraAuthors: readonly string[],
): boolean => {
  if (!author) return false;
  const norm = (s: string) => s.replace(/\[bot\]$/i, "").toLowerCase();
  const a = norm(author);
  if (login && a === norm(login)) return true;
  return extraAuthors.some((x) => norm(x) === a);
};

/**
 * Whether you left a review GitHub still shows on the PR (approved, changes
 * requested or commented) and are not asked for another one: a re-requested
 * reviewer is listed as "requested" again, whatever they said before.
 */
export const reviewedByYou = (
  reviewers: readonly Pick<Reviewer, "login" | "state" | "kind">[] | undefined,
  login: string | null | undefined,
): boolean => {
  if (!reviewers || !login) return false;
  const me = login.toLowerCase();
  const mine = reviewers.find((r) => r.kind === "user" && r.login.toLowerCase() === me);
  return mine !== undefined && (mine.state === "approved" || mine.state === "changes_requested" || mine.state === "commented");
};

export function commentAudienceFor(key: PrKey, root = stateRoot()): CommentAudienceInfo {
  const meta = readMeta(key, root);
  const override = meta.commentAudience ?? null;
  if (override) return { effective: override, override };
  const mine = authoredByYou(meta.author, cachedViewerLogin(key.host, root), readConfig(root).extraAuthors);
  return { effective: mine ? "agent" : "github", override: null };
}

/** The reader's flip for this PR; null goes back to the default by author. */
export function setCommentAudienceFor(key: PrKey, audience: CommentAudience | null, root = stateRoot()): CommentAudienceInfo {
  const { commentAudience: _drop, ...rest } = readMeta(key, root);
  writeMeta(key, audience ? { ...rest, commentAudience: audience } : rest, root);
  return commentAudienceFor(key, root);
}
