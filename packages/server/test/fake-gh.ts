import { setGhRunner, type GhRunner } from "@reviewer/core";
import { resetViewerLoginCache } from "../src/github-review.js";

export interface FakeReview {
  id: number;
  node_id: string;
  state: string;
  commit_id?: string;
  html_url?: string;
  user: { login: string };
  comments: { id: number; path: string; line: number; side: string; body: string }[];
}

export interface FakeGh {
  /** every `gh` invocation, as flat argv strings */
  calls: string[][];
  reviews: FakeReview[];
  login: string;
  /**
   * Register a failure for any call whose argv contains `match`. `after` runs
   * as the failure is raised, to model side effects that happened remotely
   * (e.g. the pending review really being gone).
   */
  fail: (match: string, message: string, once?: boolean, after?: () => void) => void;
  /** convenience: how many `POST .../pulls/{n}/reviews` calls were made */
  createReviewCalls: () => number;
  deletedCommentIds: number[];
  install: () => void;
}

/**
 * An in-memory stand-in for `gh` covering the review lifecycle endpoints.
 * Every write path in the server is exercised against this and never against
 * the real API.
 */
export function fakeGh(opts: { login?: string } = {}): FakeGh {
  const state: FakeGh = {
    calls: [],
    reviews: [],
    login: opts.login ?? "reviewer-bot",
    deletedCommentIds: [],
    fail: (match, message, once = false, after) => {
      failures.push({ match, message, once, after });
    },
    createReviewCalls: () =>
      state.calls.filter(
        (c) =>
          c.includes("--method") &&
          c.includes("POST") &&
          c.some((a) => /\/pulls\/\d+\/reviews$/.test(a)),
      ).length,
    install: () => setGhRunner(runner),
  };

  const failures: {
    match: string;
    message: string;
    once: boolean;
    after?: () => void;
  }[] = [];
  let nextReviewId = 1000;
  let nextCommentId = 5000;

  const runner: GhRunner = (args, input) => {
    state.calls.push([...args]);
    const joined = args.join(" ");

    const failure = failures.find((f) => joined.includes(f.match));
    if (failure) {
      if (failure.once) failures.splice(failures.indexOf(failure), 1);
      failure.after?.();
      throw new Error(`gh ${joined} failed: ${failure.message}`);
    }

    if (joined === "api user" || /\bapi (--hostname \S+ )?user$/.test(joined)) {
      return JSON.stringify({ login: state.login, id: 1 });
    }

    // GraphQL
    if (args[1] === "graphql") {
      const field = (name: string) => {
        const i = args.findIndex((a) => a.startsWith(`${name}=`));
        return i === -1 ? undefined : args[i].slice(name.length + 1);
      };
      const query = field("query") ?? "";

      // GraphQL: updatePullRequestReviewComment
      if (query.includes("updatePullRequestReviewComment")) {
        const commentId = field("commentId");
        const newBody = field("body");
        let found: FakeReview["comments"][number] | undefined;
        for (const review of state.reviews) {
          found = review.comments.find((cm) => String(cm.id) === commentId);
          if (found) break;
        }
        if (!found) throw new Error(`gh ${joined} failed: HTTP 404 comment not found`);
        if (newBody !== undefined) found.body = newBody;
        return JSON.stringify({
          data: {
            updatePullRequestReviewComment: {
              pullRequestReviewComment: {
                id: `PRRC_${found.id}`,
                databaseId: found.id,
                body: found.body,
              },
            },
          },
        });
      }

      // GraphQL: addPullRequestReviewThread
      const reviewId = field("reviewId");
      const review = state.reviews.find((r) => r.node_id === reviewId);
      if (!review) throw new Error(`gh ${joined} failed: HTTP 404 review not found`);
      const id = nextCommentId++;
      review.comments.push({
        id,
        path: field("path")!,
        line: Number(field("line")),
        side: field("side")!,
        body: field("body")!,
      });
      return JSON.stringify({
        data: {
          addPullRequestReviewThread: {
            thread: { id: `PRRT_${id}`, comments: { nodes: [{ id: `PRRC_${id}`, databaseId: id }] } },
          },
        },
      });
    }

    const method =
      args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
    const endpoint = args.find((a) => a.startsWith("repos/")) ?? "";
    const body = input ? (JSON.parse(input) as Record<string, unknown>) : {};

    // GET /pulls/{n}/reviews
    if (method === "GET" && /\/pulls\/\d+\/reviews\?/.test(endpoint)) {
      return JSON.stringify(
        state.reviews.map(({ comments, ...r }) => r),
      );
    }

    // GET /pulls/{n}/reviews/{id}/comments
    const listComments = endpoint.match(/\/pulls\/\d+\/reviews\/(\d+)\/comments/);
    if (method === "GET" && listComments) {
      const review = state.reviews.find((r) => r.id === Number(listComments[1]));
      return JSON.stringify(review?.comments ?? []);
    }

    // POST /pulls/{n}/reviews/{id}/events  (submit)
    const submit = endpoint.match(/\/pulls\/\d+\/reviews\/(\d+)\/events$/);
    if (method === "POST" && submit) {
      const review = state.reviews.find((r) => r.id === Number(submit[1]));
      if (!review) throw new Error(`gh ${joined} failed: HTTP 404 Not Found`);
      if (body.event === "APPROVE" && state.login === "pr-author") {
        throw new Error(
          `gh ${joined} failed: HTTP 422 Unprocessable Entity: Can not approve your own pull request`,
        );
      }
      review.state = body.event === "APPROVE" ? "APPROVED" : String(body.event);
      review.html_url = `https://github.com/acme/widgets/pull/7#pullrequestreview-${review.id}`;
      return JSON.stringify(review);
    }

    // DELETE /pulls/{n}/reviews/{id}
    const del = endpoint.match(/\/pulls\/\d+\/reviews\/(\d+)$/);
    if (method === "DELETE" && del) {
      const idx = state.reviews.findIndex((r) => r.id === Number(del[1]));
      if (idx === -1) throw new Error(`gh ${joined} failed: HTTP 404 Not Found`);
      state.reviews.splice(idx, 1);
      return "{}";
    }

    // DELETE /pulls/comments/{id}
    const delComment = endpoint.match(/\/pulls\/comments\/(\d+)$/);
    if (method === "DELETE" && delComment) {
      state.deletedCommentIds.push(Number(delComment[1]));
      return "{}";
    }

    // POST /pulls/{n}/reviews  (create pending, or create-and-submit)
    if (method === "POST" && /\/pulls\/\d+\/reviews$/.test(endpoint)) {
      const pendingExists = state.reviews.some(
        (r) => r.state === "PENDING" && r.user.login === state.login,
      );
      if (pendingExists) {
        throw new Error(
          `gh ${joined} failed: HTTP 422 Unprocessable Entity: User can only have one pending review per pull request`,
        );
      }
      if (body.event === "APPROVE" && state.login === "pr-author") {
        throw new Error(
          `gh ${joined} failed: HTTP 422 Unprocessable Entity: Can not approve your own pull request`,
        );
      }
      const id = nextReviewId++;
      const review: FakeReview = {
        id,
        node_id: `PRR_${id}`,
        state: body.event ? (body.event === "APPROVE" ? "APPROVED" : String(body.event)) : "PENDING",
        commit_id: body.commit_id as string | undefined,
        html_url: `https://github.com/acme/widgets/pull/7#pullrequestreview-${id}`,
        user: { login: state.login },
        comments: ((body.comments as Record<string, unknown>[]) ?? []).map((c) => ({
          id: nextCommentId++,
          path: String(c.path),
          line: Number(c.line),
          side: String(c.side),
          body: String(c.body),
        })),
      };
      state.reviews.push(review);
      return JSON.stringify(review);
    }

    // Anything else (viewed-state graphql, PR metadata) is not under test here.
    return "{}";
  };

  resetViewerLoginCache();
  return state;
}
