import { loadState, type PrKey } from "@reviewer/core";
import { commentCounts, markPushed, readComments, type Comment } from "./comments.js";
import {
  ReviewError,
  appendCommentToPendingReview,
  classifyGhReviewError,
  createPendingReview,
  findPendingReview,
  listReviewComments,
  type PendingReview,
  type ReviewCommentInput,
} from "./github-review.js";
import { clearPendingReview, patchReviewDraft, readReviewDraft } from "./review-store.js";

export interface CommentSyncResult {
  ok: boolean;
  /** comments moved draft -> pushed by this call */
  pushed: number;
  /** how the pending review was reached */
  mode?: "created" | "appended" | "noop";
  reviewUrl?: string;
  pendingReviewId?: string;
  pendingReviewDatabaseId?: number;
  counts?: ReturnType<typeof commentCounts>;
  error?: string;
  errorCode?: string;
}

export function headShaOf(key: PrKey, root?: string): string | undefined {
  try {
    const state = loadState(key, root);
    return state.revisions.find((r) => r.revision === state.currentRevision)?.headSha;
  } catch {
    return undefined;
  }
}

const toInput = (c: Comment): ReviewCommentInput => ({
  path: c.file,
  line: c.line,
  side: c.side,
  body: c.body,
});

/**
 * Reconcile the viewer's pending review before writing to it.
 *
 * GitHub permits exactly one pending review per user per PR, so the naive
 * "always POST /pulls/{n}/reviews" of the first implementation 422s on the
 * second sync. We therefore look the pending review up first (see
 * github-review.ts for why that lookup is REST and the append is GraphQL) and
 * branch:
 *
 *   no pending review -> create one carrying all the drafts (one REST call)
 *   pending review    -> append each draft to it via GraphQL
 *
 * Either way the review's ids are persisted to review.json so the submit and
 * discard paths do not have to rediscover them.
 */
export function pushDraftComments(key: PrKey, root?: string): CommentSyncResult {
  const all = readComments(key, root);
  const drafts = all.filter((c) => c.status === "draft");

  let pending: PendingReview | undefined;
  try {
    pending = findPendingReview(key);
  } catch (err) {
    const e = classifyGhReviewError(err);
    return { ok: false, pushed: 0, error: e.message, errorCode: e.code };
  }

  // Keep review.json honest even when there is nothing to push: a pending
  // review may have been created or discarded outside this app.
  if (pending) {
    patchReviewDraft(
      key,
      {
        pendingReviewId: pending.nodeId,
        pendingReviewDatabaseId: pending.databaseId,
      },
      root,
    );
  } else if (readReviewDraft(key, root).pendingReviewId) {
    clearPendingReview(key, root);
  }

  if (drafts.length === 0) {
    return {
      ok: true,
      pushed: 0,
      mode: "noop",
      pendingReviewId: pending?.nodeId,
      pendingReviewDatabaseId: pending?.databaseId,
      counts: commentCounts(all),
    };
  }

  try {
    if (!pending) {
      const commitId = headShaOf(key, root);
      if (!commitId) {
        return {
          ok: false,
          pushed: 0,
          error: "No head sha on record for the current revision",
          errorCode: "no_commit_id",
        };
      }
      const created = createPendingReview(key, commitId, drafts.map(toInput));
      // The create response carries no per-comment ids; this read backfills
      // them so a later local delete/edit can act on the right remote
      // comment. Matching is by path+line, consumed once per match: two
      // drafts can legitimately target the same file+line (e.g. a comment
      // added after an earlier one at the same spot was deleted upstream),
      // and reusing the same remote id for both would silently mis-attribute
      // one of them. Removing each match as it's used keeps the pairing
      // 1:1 even when path+line repeats.
      const remote = listReviewComments(key, created.databaseId);
      const remaining = [...remote];
      markPushed(
        key,
        drafts.map((c) => {
          const idx = remaining.findIndex(
            (r) => r.path === c.file && (r.line ?? r.original_line) === c.line,
          );
          const match = idx === -1 ? undefined : remaining.splice(idx, 1)[0];
          return { id: c.id, githubCommentId: match?.id };
        }),
        root,
      );
      patchReviewDraft(
        key,
        {
          pendingReviewId: created.nodeId,
          pendingReviewDatabaseId: created.databaseId,
          lastSyncedAt: new Date().toISOString(),
        },
        root,
      );
      return {
        ok: true,
        pushed: drafts.length,
        mode: "created",
        reviewUrl: created.htmlUrl,
        pendingReviewId: created.nodeId,
        pendingReviewDatabaseId: created.databaseId,
        counts: commentCounts(readComments(key, root)),
      };
    }

    // Append one thread at a time; record each success as we go so a failure
    // halfway through does not lose track of what already landed remotely.
    let pushed = 0;
    let failure: ReviewError | undefined;
    for (const draft of drafts) {
      try {
        const res = appendCommentToPendingReview(key, pending.nodeId, toInput(draft));
        markPushed(
          key,
          [{ id: draft.id, githubCommentId: res.commentId, githubThreadId: res.threadId }],
          root,
        );
        pushed += 1;
      } catch (err) {
        failure = classifyGhReviewError(err);
        break;
      }
    }
    patchReviewDraft(key, { lastSyncedAt: new Date().toISOString() }, root);
    return {
      ok: !failure,
      pushed,
      mode: "appended",
      pendingReviewId: pending.nodeId,
      pendingReviewDatabaseId: pending.databaseId,
      counts: commentCounts(readComments(key, root)),
      error: failure?.message,
      errorCode: failure?.code,
    };
  } catch (err) {
    const e = classifyGhReviewError(err);
    return { ok: false, pushed: 0, error: e.message, errorCode: e.code };
  }
}

/** Back-compatible name used by POST /api/prs/:key/sync. */
export const syncCommentsToGithub = pushDraftComments;
