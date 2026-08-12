import {
  appendEvent,
  lastReviewSubmission,
  loadState,
  readiness,
  type PrKey,
  type ReadinessSummary,
} from "@reviewer/core";
import { commentCounts, markSubmitted, readComments, resetPushedToDraft } from "./comments.js";
import { headShaOf, pushDraftComments, type CommentSyncResult } from "./comment-sync.js";
import {
  ReviewError,
  classifyGhReviewError,
  createAndSubmitReview,
  deletePendingReview,
  findPendingReview,
  statusForReviewCode,
  submitPendingReview,
  type SubmitEvent,
} from "./github-review.js";
import {
  clearPendingReview,
  patchReviewDraft,
  readReviewDraft,
  type ReviewDraft,
} from "./review-store.js";

export const SUBMIT_EVENTS: SubmitEvent[] = ["APPROVE", "REQUEST_CHANGES", "COMMENT"];

export interface ReviewStatus {
  draft: ReviewDraft;
  comments: {
    counts: ReturnType<typeof commentCounts>;
    /** everything that would ride along on a submit, in file order */
    included: {
      id: string;
      file: string;
      line: number;
      side: "LEFT" | "RIGHT";
      body: string;
      status: string;
    }[];
  };
  pending: {
    /** null when we did not (or could not) ask GitHub */
    known: boolean;
    exists: boolean;
    databaseId?: number;
    nodeId?: string;
    error?: string;
  };
  readiness: ReadinessSummary;
  lastSubmission?: ReturnType<typeof lastReviewSubmission>;
}

/**
 * Local draft + remote pending status + counts + readiness. The remote lookup
 * is best-effort: an offline or rate-limited `gh` should still let the panel
 * render everything local.
 */
export function reviewStatus(
  key: PrKey,
  root?: string,
  opts: { checkRemote?: boolean } = {},
): ReviewStatus {
  const draft = readReviewDraft(key, root);
  const comments = readComments(key, root);
  const state = loadState(key, root);

  let pending: ReviewStatus["pending"] = { known: false, exists: false };
  if (opts.checkRemote !== false) {
    try {
      const found = findPendingReview(key);
      pending = found
        ? { known: true, exists: true, databaseId: found.databaseId, nodeId: found.nodeId }
        : { known: true, exists: false };
    } catch (err) {
      pending = { known: false, exists: false, error: classifyGhReviewError(err).message };
    }
  }

  return {
    draft,
    comments: {
      counts: commentCounts(comments),
      included: comments
        .filter((c) => c.status !== "submitted")
        .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
        .map((c) => ({
          id: c.id,
          file: c.file,
          line: c.line,
          side: c.side,
          body: c.body,
          status: c.status,
        })),
    },
    pending,
    readiness: readiness(state),
    lastSubmission: lastReviewSubmission(state),
  };
}

export function saveReviewBody(key: PrKey, body: string, root?: string): ReviewDraft {
  return patchReviewDraft(key, { body }, root);
}

export interface SubmitResult {
  ok: true;
  event: SubmitEvent;
  url?: string;
  commentCount: number;
  push?: CommentSyncResult;
  draft: ReviewDraft;
}

/**
 * Finish the review.
 *
 * Order matters: un-pushed drafts are pushed first (creating or growing the
 * pending review), and only then is the review submitted, so the comments and
 * the verdict land as one review rather than a verdict plus orphaned threads.
 *
 * Two shapes of submit exist because GitHub has two:
 *   - a pending review exists  -> POST /pulls/{n}/reviews/{id}/events
 *   - nothing pending, no comments -> POST /pulls/{n}/reviews with an `event`
 *
 * If the pending review was deleted out of band, GitHub answers 404. We clear
 * the cached id and retry exactly once, which turns the common "I discarded it
 * in the GitHub UI" case into a create-and-submit instead of an error.
 */
export function submitReview(
  key: PrKey,
  input: { event: SubmitEvent; body?: string },
  root?: string,
): SubmitResult {
  const bodyText = input.body ?? readReviewDraft(key, root).body;

  const push = pushDraftComments(key, root);
  if (!push.ok) {
    throw new ReviewError(
      (push.errorCode as ReviewError["code"]) ?? "gh_failed",
      push.error ?? "Could not push draft comments before submitting",
      push.error,
      statusForReviewCode(push.errorCode),
    );
  }

  const pushedIds = readComments(key, root)
    .filter((c) => c.status === "pushed")
    .map((c) => c.id);

  const run = (attempt: number): { url?: string } => {
    const draft = readReviewDraft(key, root);
    const reviewId = draft.pendingReviewDatabaseId ?? push.pendingReviewDatabaseId;
    try {
      if (reviewId !== undefined) {
        return { url: submitPendingReview(key, reviewId, input.event, bodyText).htmlUrl };
      }
      return {
        url: createAndSubmitReview(key, input.event, bodyText, headShaOf(key, root)).htmlUrl,
      };
    } catch (err) {
      const e = classifyGhReviewError(err);
      if (e.code === "pending_review_gone" && attempt === 0) {
        // Stale id: forget it, and let the retry take the create-and-submit
        // branch. Anything we thought was pushed is gone with the review.
        clearPendingReview(key, root);
        resetPushedToDraft(key, root);
        const repush = pushDraftComments(key, root);
        if (!repush.ok) {
          throw new ReviewError(
            (repush.errorCode as ReviewError["code"]) ?? "gh_failed",
            repush.error ?? "Could not re-push draft comments after the pending review vanished",
            repush.error,
            statusForReviewCode(repush.errorCode),
          );
        }
        return run(1);
      }
      throw e;
    }
  };

  const { url } = run(0);

  const ids = pushedIds.length
    ? pushedIds
    : readComments(key, root)
        .filter((c) => c.status === "pushed")
        .map((c) => c.id);
  markSubmitted(key, ids, root);
  const now = new Date().toISOString();
  const draft = patchReviewDraft(
    key,
    {
      pendingReviewId: undefined,
      pendingReviewDatabaseId: undefined,
      submittedAt: now,
      submittedEvent: input.event,
      submittedUrl: url,
    },
    root,
  );
  // Written to review.json above; the durable record is this event.
  appendEvent(
    key,
    { type: "review-submitted", event: input.event, url, commentCount: ids.length },
    root,
  );

  return { ok: true, event: input.event, url, commentCount: ids.length, push, draft };
}

export interface DiscardResult {
  ok: true;
  discarded: boolean;
  resetToDraft: number;
}

/**
 * Throw away the pending review on GitHub and pull its comments back into the
 * local drafts, so nothing the reader wrote is lost.
 */
export function discardPendingReview(key: PrKey, root?: string): DiscardResult {
  const draft = readReviewDraft(key, root);
  let reviewId = draft.pendingReviewDatabaseId;
  if (reviewId === undefined) {
    reviewId = findPendingReview(key)?.databaseId;
  }
  if (reviewId === undefined) {
    clearPendingReview(key, root);
    return { ok: true, discarded: false, resetToDraft: resetPushedToDraft(key, root) };
  }
  try {
    deletePendingReview(key, reviewId);
  } catch (err) {
    const e = classifyGhReviewError(err);
    // Already gone is the outcome we wanted; anything else is a real failure.
    if (e.code !== "pending_review_gone") throw e;
  }
  clearPendingReview(key, root);
  return { ok: true, discarded: true, resetToDraft: resetPushedToDraft(key, root) };
}
