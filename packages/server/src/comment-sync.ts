import { loadState, type PrKey } from "@reviewer/core";
import { commentCounts, markPushed, readComments, type Comment } from "./comments.js";
import {
  ReviewError,
  appendCommentToPendingReview,
  classifyGhReviewError,
  createPendingReview,
  findPendingReview,
  listPullRequestComments,
  listReviewComments,
  type PendingReview,
  type LineReviewCommentInput,
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

/** Narrowed variant for the REST create payload, which takes line comments only. */
const toLineInput = (c: Comment): LineReviewCommentInput => ({
  subjectType: "line",
  path: c.file,
  line: c.line!,
  side: c.side!,
  body: c.body,
});

const toInput = (c: Comment): ReviewCommentInput =>
  c.subjectType === "file"
    ? { subjectType: "file", path: c.file, body: c.body }
    : {
        subjectType: "line",
        path: c.file,
        line: c.line!,
        side: c.side!,
        body: c.body,
      };

/**
 * Append drafts to an existing pending review one thread at a time, recording
 * each success as it lands so a failure halfway through does not lose track of
 * what already exists remotely. Shared by both branches of the push: the
 * "created" branch also comes through here for its file-level drafts, which
 * the REST create payload cannot express (see github-review.ts).
 */
function appendDrafts(
  key: PrKey,
  reviewNodeId: string,
  drafts: Comment[],
  root?: string,
): { pushed: number; failure?: ReviewError } {
  let pushed = 0;
  for (const draft of drafts) {
    try {
      const res = appendCommentToPendingReview(key, reviewNodeId, toInput(draft));
      markPushed(
        key,
        [
          {
            id: draft.id,
            githubCommentId: res.commentId,
            githubCommentNodeId: res.commentNodeId,
            githubThreadId: res.threadId,
          },
        ],
        root,
      );
      pushed += 1;
    } catch (err) {
      return { pushed, failure: classifyGhReviewError(err) };
    }
  }
  return { pushed };
}

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
      // The REST create payload has no `subject_type`, so file-level drafts
      // cannot ride along in it; they are appended to the review it creates,
      // via the GraphQL mutation that can express them. Line drafts still go
      // out in the single create call.
      const lineDrafts = drafts.filter((c) => c.subjectType === "line");
      const fileDrafts = drafts.filter((c) => c.subjectType === "file");
      const created = createPendingReview(key, commitId, lineDrafts.map(toLineInput));
      // The create response carries no per-comment ids; this read backfills
      // both the REST databaseId (githubCommentId) and the GraphQL node id
      // (githubCommentNodeId — REST comment payloads carry it as `node_id`)
      // so a later local delete/edit can act on the right remote comment,
      // via whichever API needs which id. Matching is by path+line, consumed
      // once per match: two drafts can legitimately target the same
      // file+line (e.g. a comment added after an earlier one at the same
      // spot was deleted upstream), and reusing the same remote comment for
      // both would silently mis-attribute one of them. Removing each match
      // as it's used keeps the pairing 1:1 even when path+line repeats.
      const remote = listReviewComments(key, created.databaseId);
      // File-level remote comments can never be the match for a line draft,
      // and carry no line to match on anyway — exclude them explicitly so a
      // null line never pairs with a line draft by accident.
      const remaining = remote.filter((r) => r.subject_type !== "file");
      markPushed(
        key,
        lineDrafts.map((c) => {
          const idx = remaining.findIndex(
            (r) => r.path === c.file && (r.line ?? r.original_line) === c.line,
          );
          const match = idx === -1 ? undefined : remaining.splice(idx, 1)[0];
          return { id: c.id, githubCommentId: match?.id, githubCommentNodeId: match?.node_id };
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
      const appended = appendDrafts(key, created.nodeId, fileDrafts, root);
      return {
        ok: !appended.failure,
        pushed: lineDrafts.length + appended.pushed,
        mode: "created",
        reviewUrl: created.htmlUrl,
        pendingReviewId: created.nodeId,
        pendingReviewDatabaseId: created.databaseId,
        counts: commentCounts(readComments(key, root)),
        error: appended.failure?.message,
        errorCode: appended.failure?.code,
      };
    }

    const { pushed, failure } = appendDrafts(key, pending.nodeId, drafts, root);
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

/**
 * Best-effort, read-only recovery of a comment's GraphQL node id when the
 * push-time backfill above missed it (e.g. `listReviewComments` failed, or
 * the comment predates node-id backfilling). Never issues a write call.
 *
 *   pushed    -> `GET /pulls/{n}/reviews/{id}/comments` on the pending
 *                review (comments still awaiting submission aren't visible
 *                anywhere else).
 *   submitted -> `GET /pulls/{n}/comments`, the PR-wide listing that only
 *                surfaces comments belonging to already-submitted reviews.
 *
 * Returns undefined if recovery isn't possible (no databaseId to match on,
 * no pending review on record, or the id genuinely isn't found).
 */
export function recoverCommentNodeId(
  key: PrKey,
  comment: Comment,
  root?: string,
): string | undefined {
  if (comment.githubCommentId === undefined) return undefined;

  if (comment.status === "pushed") {
    let reviewDatabaseId = readReviewDraft(key, root).pendingReviewDatabaseId;
    if (reviewDatabaseId === undefined) {
      try {
        reviewDatabaseId = findPendingReview(key)?.databaseId;
      } catch {
        return undefined;
      }
    }
    if (reviewDatabaseId === undefined) return undefined;
    return listReviewComments(key, reviewDatabaseId).find((r) => r.id === comment.githubCommentId)
      ?.node_id;
  }

  if (comment.status === "submitted") {
    return listPullRequestComments(key).find((r) => r.id === comment.githubCommentId)?.node_id;
  }

  return undefined;
}
