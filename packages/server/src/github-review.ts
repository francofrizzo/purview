import { gh, type PrKey } from "@reviewer/core";

/**
 * Every GitHub call involved in the "pending review -> submitted review"
 * lifecycle. Split out from comment-sync so the reconciliation logic reads as
 * policy and this file holds the (fiddly) API mechanics.
 *
 * ## Why REST for discovery
 *
 * `GET /repos/{o}/{r}/pulls/{n}/reviews` returns the authenticated viewer's
 * own PENDING review alongside the public ones, and — crucially — it returns
 * BOTH identifiers we need in one call: `id` (databaseId, required by the REST
 * submit/delete endpoints) and `node_id` (required by the GraphQL append
 * mutation). The GraphQL equivalent (`pullRequest { reviews(states: PENDING) }`)
 * would work too but needs a second lookup to get one of the two ids in the
 * shape the other API wants, so REST is strictly less work. A pending review
 * is only ever visible to its author, so filtering by the viewer's login is
 * enough to identify "my pending review".
 *
 * ## Why GraphQL for appending
 *
 * REST has no way to add a comment to an *existing* pending review: `POST
 * /pulls/{n}/reviews` always creates a new review (and 422s when one is
 * already pending), and `POST /pulls/{n}/comments` posts a standalone comment
 * immediately — public, outside the review. GraphQL's
 * `addPullRequestReviewThread` takes a `pullRequestReviewId` and attaches the
 * thread to that pending review, which is exactly the missing operation.
 */

function hostArgs(host: string): string[] {
  return host && host !== "github.com" ? ["--hostname", host] : [];
}

function ghJson<T>(key: PrKey, args: string[], input?: string): T {
  return JSON.parse(gh(["api", ...hostArgs(key.host), ...args], input)) as T;
}

/* ------------------------------------------------------------ error shapes */

export type ReviewErrorCode =
  | "cannot_approve_own_pr"
  | "stale_commit_id"
  | "pending_review_gone"
  | "pending_review_exists"
  | "comment_line_not_in_diff"
  | "not_authenticated"
  | "gh_failed";

export class ReviewError extends Error {
  constructor(
    readonly code: ReviewErrorCode,
    message: string,
    readonly detail?: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = "ReviewError";
  }
}

const STATUS_BY_CODE: Record<ReviewErrorCode, number> = {
  cannot_approve_own_pr: 422,
  stale_commit_id: 422,
  pending_review_gone: 404,
  pending_review_exists: 422,
  comment_line_not_in_diff: 422,
  not_authenticated: 502,
  gh_failed: 502,
};

/** HTTP status a given failure mode should surface as. */
export function statusForReviewCode(code: string | undefined): number {
  return STATUS_BY_CODE[(code ?? "gh_failed") as ReviewErrorCode] ?? 502;
}

/**
 * `gh` surfaces the API's own message in stderr, so the failure modes we care
 * about are distinguishable by text. Matching on text is unlovely but it is
 * the only signal available through the CLI.
 */
export function classifyGhReviewError(err: unknown): ReviewError {
  if (err instanceof ReviewError) return err;
  const raw = err instanceof Error ? err.message : String(err);

  if (/can ?not approve your own pull ?request/i.test(raw)) {
    return new ReviewError(
      "cannot_approve_own_pr",
      "GitHub does not allow approving your own pull request",
      raw,
      422,
    );
  }
  if (/HTTP 404/i.test(raw)) {
    return new ReviewError(
      "pending_review_gone",
      "The pending review no longer exists on GitHub",
      raw,
      404,
    );
  }
  if (/user can only have one pending review|pending review/i.test(raw) && /HTTP 422/i.test(raw)) {
    return new ReviewError(
      "pending_review_exists",
      "A pending review already exists for this pull request",
      raw,
      422,
    );
  }
  if (
    /commit_id|no commit found|not part of the pull request|head sha/i.test(raw) &&
    /HTTP 422|Validation Failed/i.test(raw)
  ) {
    return new ReviewError(
      "stale_commit_id",
      "The head commit moved since this revision was fetched — refresh the PR and try again",
      raw,
      422,
    );
  }
  if (
    /line must be part of the diff|not part of the diff|pull_request_review_thread|invalid line|must be part of the/i.test(
      raw,
    )
  ) {
    return new ReviewError(
      "comment_line_not_in_diff",
      "A comment targets a line that is no longer part of the diff — refresh the PR and re-anchor it",
      raw,
      422,
    );
  }
  return new ReviewError("gh_failed", "GitHub call failed", raw, 502);
}

/* -------------------------------------------------------------- viewer id */

let cachedLogin: { host: string; login: string } | undefined;

/** `gh api user` -> login. Cached per host for the life of the process. */
export function viewerLogin(key: PrKey): string {
  if (cachedLogin && cachedLogin.host === key.host) return cachedLogin.login;
  try {
    const user = ghJson<{ login?: string }>(key, ["user"]);
    if (!user.login) {
      throw new ReviewError(
        "not_authenticated",
        "`gh api user` returned no login — is gh authenticated?",
        JSON.stringify(user),
        502,
      );
    }
    cachedLogin = { host: key.host, login: user.login };
    return user.login;
  } catch (err) {
    throw classifyGhReviewError(err);
  }
}

/** Test seam: drop the memoized login (also used after an auth error). */
export function resetViewerLoginCache(): void {
  cachedLogin = undefined;
}

/* ------------------------------------------------------- pending review IO */

export interface PendingReview {
  /** REST id — what the submit/delete endpoints take */
  databaseId: number;
  /** GraphQL node id — what addPullRequestReviewThread takes */
  nodeId: string;
  commitId?: string;
  htmlUrl?: string;
}

interface RawReview {
  id: number;
  node_id: string;
  state: string;
  commit_id?: string;
  html_url?: string;
  user?: { login?: string } | null;
}

/** The viewer's PENDING review on this PR, if there is one. */
export function findPendingReview(key: PrKey): PendingReview | undefined {
  const login = viewerLogin(key);
  let reviews: RawReview[];
  try {
    // No --paginate: gh emits one JSON array per page, which is not parseable
    // as a whole. 100 reviews is far beyond what a PR under review has, and
    // the viewer's pending review is always the newest.
    reviews = ghJson<RawReview[]>(key, [
      `repos/${key.owner}/${key.repo}/pulls/${key.number}/reviews?per_page=100`,
    ]);
  } catch (err) {
    throw classifyGhReviewError(err);
  }
  const mine = (Array.isArray(reviews) ? reviews : []).filter(
    (r) => r.state === "PENDING" && r.user?.login === login,
  );
  // GitHub allows at most one, but take the newest defensively.
  const found = mine[mine.length - 1];
  if (!found) return undefined;
  return {
    databaseId: found.id,
    nodeId: found.node_id,
    commitId: found.commit_id,
    htmlUrl: found.html_url,
  };
}

export interface ReviewCommentInput {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
}

export interface CreatedReview {
  databaseId: number;
  nodeId: string;
  htmlUrl?: string;
  state?: string;
}

/**
 * `POST /pulls/{n}/reviews` with no `event` — creates a PENDING review holding
 * the given comments. 422s if the viewer already has one pending, which is why
 * callers must reconcile first.
 */
export function createPendingReview(
  key: PrKey,
  commitId: string,
  comments: ReviewCommentInput[],
): CreatedReview {
  try {
    const raw = ghJson<{ id: number; node_id: string; html_url?: string; state?: string }>(
      key,
      ["--method", "POST", `repos/${key.owner}/${key.repo}/pulls/${key.number}/reviews`, "--input", "-"],
      JSON.stringify({ commit_id: commitId, comments }),
    );
    return {
      databaseId: raw.id,
      nodeId: raw.node_id,
      htmlUrl: raw.html_url,
      state: raw.state,
    };
  } catch (err) {
    throw classifyGhReviewError(err);
  }
}

const ADD_THREAD = `mutation($reviewId:ID!,$path:String!,$line:Int!,$side:DiffSide!,$body:String!){
  addPullRequestReviewThread(input:{
    pullRequestReviewId:$reviewId, path:$path, line:$line, side:$side, body:$body
  }){
    thread{ id comments(first:1){ nodes{ id databaseId } } }
  }
}`;

export interface AppendedComment {
  threadId?: string;
  commentId?: number;
}

/** GraphQL `addPullRequestReviewThread` — the only way to grow a pending review. */
export function appendCommentToPendingReview(
  key: PrKey,
  reviewNodeId: string,
  comment: ReviewCommentInput,
): AppendedComment {
  let res: {
    data?: {
      addPullRequestReviewThread?: {
        thread?: {
          id?: string;
          comments?: { nodes?: { id?: string; databaseId?: number }[] };
        } | null;
      } | null;
    };
    errors?: { message?: string }[];
  };
  try {
    // -f keeps values as strings (paths and bodies must never be magically
    // coerced); -F is used only where GraphQL wants a real Int.
    res = JSON.parse(
      gh([
        "api",
        "graphql",
        ...hostArgs(key.host),
        "-f",
        `query=${ADD_THREAD}`,
        "-f",
        `reviewId=${reviewNodeId}`,
        "-f",
        `path=${comment.path}`,
        "-F",
        `line=${comment.line}`,
        "-f",
        `side=${comment.side}`,
        "-f",
        `body=${comment.body}`,
      ]),
    );
  } catch (err) {
    throw classifyGhReviewError(err);
  }
  if (res.errors?.length) {
    throw classifyGhReviewError(new Error(res.errors.map((e) => e.message).join("; ")));
  }
  const node = res.data?.addPullRequestReviewThread?.thread?.comments?.nodes?.[0];
  return {
    threadId: res.data?.addPullRequestReviewThread?.thread?.id,
    commentId: node?.databaseId,
  };
}

/**
 * `GET /pulls/{n}/reviews/{id}/comments` — pending review comments are not in
 * the PR-wide comment listing, but they are here. Read-only; used to backfill
 * REST ids after creating a review (whose response carries no comment ids).
 */
export function listReviewComments(
  key: PrKey,
  reviewDatabaseId: number,
): { id: number; path: string; line?: number; original_line?: number; side?: string; body: string }[] {
  try {
    return ghJson(key, [
      `repos/${key.owner}/${key.repo}/pulls/${key.number}/reviews/${reviewDatabaseId}/comments?per_page=100`,
    ]);
  } catch {
    // Purely an id-backfill nicety; never fail a push over it.
    return [];
  }
}

const UPDATE_COMMENT = `mutation($commentId:ID!,$body:String!){
  updatePullRequestReviewComment(input:{
    pullRequestReviewCommentId:$commentId, body:$body
  }){
    pullRequestReviewComment{ id databaseId body }
  }
}`;

export interface UpdatedReviewComment {
  id?: string;
  databaseId?: number;
  body?: string;
}

/**
 * GraphQL `updatePullRequestReviewComment` — edits the body of an existing
 * review comment, whether it is still sitting in a pending review or already
 * part of a submitted one. Takes the id we have on file (`githubCommentId`,
 * backfilled at push time — see comment-sync.ts for how, and its known gap
 * when backfill fails).
 */
export function updatePullRequestReviewCommentBody(
  key: PrKey,
  commentId: number | string,
  body: string,
): UpdatedReviewComment {
  let res: {
    data?: {
      updatePullRequestReviewComment?: {
        pullRequestReviewComment?: { id?: string; databaseId?: number; body?: string } | null;
      } | null;
    };
    errors?: { message?: string }[];
  };
  try {
    res = JSON.parse(
      gh([
        "api",
        "graphql",
        ...hostArgs(key.host),
        "-f",
        `query=${UPDATE_COMMENT}`,
        "-f",
        `commentId=${commentId}`,
        "-f",
        `body=${body}`,
      ]),
    );
  } catch (err) {
    throw classifyGhReviewError(err);
  }
  if (res.errors?.length) {
    throw classifyGhReviewError(new Error(res.errors.map((e) => e.message).join("; ")));
  }
  const c = res.data?.updatePullRequestReviewComment?.pullRequestReviewComment;
  return { id: c?.id, databaseId: c?.databaseId, body: c?.body };
}

export type SubmitEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

/** `POST /pulls/{n}/reviews/{id}/events` — submits an existing pending review. */
export function submitPendingReview(
  key: PrKey,
  reviewDatabaseId: number,
  event: SubmitEvent,
  body?: string,
): CreatedReview {
  try {
    const raw = ghJson<{ id: number; node_id: string; html_url?: string; state?: string }>(
      key,
      [
        "--method",
        "POST",
        `repos/${key.owner}/${key.repo}/pulls/${key.number}/reviews/${reviewDatabaseId}/events`,
        "--input",
        "-",
      ],
      JSON.stringify({ event, ...(body ? { body } : {}) }),
    );
    return { databaseId: raw.id, nodeId: raw.node_id, htmlUrl: raw.html_url, state: raw.state };
  } catch (err) {
    throw classifyGhReviewError(err);
  }
}

/** `POST /pulls/{n}/reviews` with an `event` — create and submit in one shot. */
export function createAndSubmitReview(
  key: PrKey,
  event: SubmitEvent,
  body: string | undefined,
  commitId: string | undefined,
): CreatedReview {
  try {
    const raw = ghJson<{ id: number; node_id: string; html_url?: string; state?: string }>(
      key,
      ["--method", "POST", `repos/${key.owner}/${key.repo}/pulls/${key.number}/reviews`, "--input", "-"],
      JSON.stringify({
        event,
        ...(body ? { body } : {}),
        ...(commitId ? { commit_id: commitId } : {}),
      }),
    );
    return { databaseId: raw.id, nodeId: raw.node_id, htmlUrl: raw.html_url, state: raw.state };
  } catch (err) {
    throw classifyGhReviewError(err);
  }
}

/** `DELETE /pulls/{n}/reviews/{id}` — discards a pending review and its comments. */
export function deletePendingReview(key: PrKey, reviewDatabaseId: number): void {
  try {
    gh([
      "api",
      "--method",
      "DELETE",
      ...hostArgs(key.host),
      `repos/${key.owner}/${key.repo}/pulls/${key.number}/reviews/${reviewDatabaseId}`,
    ]);
  } catch (err) {
    throw classifyGhReviewError(err);
  }
}
