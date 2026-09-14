import { execFileSync } from "node:child_process";
import type { PrKey, RepoKey } from "./paths.js";
import type { PrState, ReviewDecision } from "./schemas.js";

/**
 * Every `gh` invocation in the project funnels through here so the server
 * package can reuse it (and tests can swap the runner out).
 */
export type GhRunner = (args: string[], input?: string) => string;

const defaultRunner: GhRunner = (args, input) => {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      input,
      maxBuffer: 128 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message: string };
    const detail = (e.stderr || e.stdout || e.message || "").toString().trim();
    throw new Error(`gh ${args.join(" ")} failed: ${detail}`);
  }
};

let runner: GhRunner = defaultRunner;

/** Swap the `gh` runner (tests, or a server that wants its own process pool). */
export function setGhRunner(next: GhRunner | null): void {
  runner = next ?? defaultRunner;
}

export function gh(args: string[], input?: string): string {
  return runner(args, input);
}

function hostArgs(host: string): string[] {
  // gh defaults to github.com; GHE hosts need an explicit --hostname.
  return host && host !== "github.com" ? ["--hostname", host] : [];
}

function ghJson<T>(host: string, args: string[], input?: string): T {
  return JSON.parse(gh(["api", ...hostArgs(host), ...args], input)) as T;
}

export interface PullRequestInfo {
  nodeId: string;
  number: number;
  title: string;
  url: string;
  /** raw REST state: "open" | "closed" */
  state: string;
  draft: boolean;
  merged: boolean;
  /** the four-value state the UI shows */
  prState: PrState;
  /** GitHub login of the PR author, when the payload carries one. */
  author?: string;
  authorAvatarUrl?: string;
  baseRef: string;
  headRef: string;
  baseSha: string;
  headSha: string;
}

interface RawPull {
  node_id: string;
  number: number;
  title: string;
  html_url: string;
  state: string;
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  user?: { login?: string; avatar_url?: string } | null;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
}

/**
 * GitHub reports three orthogonal things (state, merged, draft); the UI wants
 * one. Merged wins over closed (every merged PR is also closed), and draft is
 * only meaningful while the PR is open.
 */
export function collapsePrState(raw: {
  state?: string;
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
}): PrState {
  if (raw.merged || raw.merged_at) return "merged";
  if ((raw.state ?? "open").toLowerCase() === "closed") return "closed";
  return raw.draft ? "draft" : "open";
}

/** `gh api repos/{owner}/{repo}/pulls/{number}` */
export function fetchPullRequest(key: PrKey): PullRequestInfo {
  const raw = ghJson<RawPull>(key.host, [
    `repos/${key.owner}/${key.repo}/pulls/${key.number}`,
  ]);
  return {
    nodeId: raw.node_id,
    number: raw.number,
    title: raw.title,
    url: raw.html_url,
    state: raw.state,
    draft: !!raw.draft,
    merged: !!(raw.merged || raw.merged_at),
    prState: collapsePrState(raw),
    author: raw.user?.login ?? undefined,
    authorAvatarUrl: raw.user?.avatar_url ?? undefined,
    baseRef: raw.base.ref,
    headRef: raw.head.ref,
    baseSha: raw.base.sha,
    headSha: raw.head.sha,
  };
}

/** Same endpoint with the v3.diff media type — the unified diff GitHub serves. */
export function fetchPullDiff(key: PrKey): string {
  return gh([
    "api",
    ...hostArgs(key.host),
    `repos/${key.owner}/${key.repo}/pulls/${key.number}`,
    "-H",
    "Accept: application/vnd.github.v3.diff",
  ]);
}

/** True merge base of base..head (the diff GitHub shows is against this). */
export function fetchMergeBase(
  key: PrKey,
  baseSha: string,
  headSha: string,
): string {
  const raw = ghJson<{ merge_base_commit: { sha: string } }>(key.host, [
    `repos/${key.owner}/${key.repo}/compare/${baseSha}...${headSha}`,
  ]);
  return raw.merge_base_commit?.sha ?? baseSha;
}

const VIEWED_STATE_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      id
      files(first:100, after:$cursor){
        pageInfo{ hasNextPage endCursor }
        nodes{ path viewerViewedState }
      }
    }
  }
}`;

export interface RemoteViewedState {
  pullRequestId: string;
  /** path -> VIEWED | UNVIEWED | DISMISSED */
  files: Record<string, string>;
}

/** Read-only: used to detect drift. Local state is never overwritten by this. */
export function fetchRemoteViewedState(key: PrKey): RemoteViewedState {
  const files: Record<string, string> = {};
  let cursor: string | null = null;
  let pullRequestId = "";
  for (;;) {
    const args = [
      "api",
      "graphql",
      ...hostArgs(key.host),
      "-f",
      `query=${VIEWED_STATE_QUERY}`,
      "-F",
      `owner=${key.owner}`,
      "-F",
      `repo=${key.repo}`,
      "-F",
      `number=${key.number}`,
    ];
    if (cursor) args.push("-F", `cursor=${cursor}`);
    const res = JSON.parse(gh(args)) as {
      data: {
        repository: {
          pullRequest: {
            id: string;
            files: {
              pageInfo: { hasNextPage: boolean; endCursor: string };
              nodes: { path: string; viewerViewedState: string }[];
            };
          };
        };
      };
    };
    const pr = res.data.repository.pullRequest;
    pullRequestId = pr.id;
    for (const n of pr.files.nodes) files[n.path] = n.viewerViewedState;
    if (!pr.files.pageInfo.hasNextPage) break;
    cursor = pr.files.pageInfo.endCursor;
  }
  return { pullRequestId, files };
}

const MARK_VIEWED = `mutation($pullRequestId:ID!,$path:String!){
  markFileAsViewed(input:{pullRequestId:$pullRequestId, path:$path}){ clientMutationId }
}`;

const UNMARK_VIEWED = `mutation($pullRequestId:ID!,$path:String!){
  unmarkFileAsViewed(input:{pullRequestId:$pullRequestId, path:$path}){ clientMutationId }
}`;

/** GraphQL `markFileAsViewed` / `unmarkFileAsViewed`. */
export function setFileViewedOnGithub(
  key: PrKey,
  pullRequestId: string,
  file: string,
  viewed: boolean,
): void {
  gh([
    "api",
    "graphql",
    ...hostArgs(key.host),
    "-f",
    `query=${viewed ? MARK_VIEWED : UNMARK_VIEWED}`,
    "-F",
    `pullRequestId=${pullRequestId}`,
    "-F",
    `path=${file}`,
  ]);
}

/* -------------------------------------------------------- review decision */

const REVIEW_DECISION_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){ reviewDecision }
  }
}`;

/**
 * GitHub's aggregate review decision. Verified against the API: the REST pull
 * payload has no `review_decision` field at all, so this needs GraphQL. It is
 * one extra cheap query on init/refresh, and it is best-effort — a GHE that
 * does not know the field, or any transport failure, yields `null` rather than
 * failing the refresh that carries it.
 */
export function fetchReviewDecision(key: PrKey): ReviewDecision | null {
  try {
    const res = JSON.parse(
      gh([
        "api",
        "graphql",
        ...hostArgs(key.host),
        "-f",
        `query=${REVIEW_DECISION_QUERY}`,
        "-F",
        `owner=${key.owner}`,
        "-F",
        `repo=${key.repo}`,
        "-F",
        `number=${key.number}`,
      ]),
    ) as {
      data?: { repository?: { pullRequest?: { reviewDecision?: string | null } } };
    };
    const raw = res.data?.repository?.pullRequest?.reviewDecision;
    if (typeof raw !== "string" || raw === "") return null;
    const normalized = raw.toLowerCase();
    return normalized === "approved" ||
      normalized === "changes_requested" ||
      normalized === "review_required"
      ? (normalized as ReviewDecision)
      : null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------- review-requested PRs */

export interface ReviewRequestedPr {
  number: number;
  title: string;
  updatedAt: string;
}

interface RawSearchPull {
  number: number;
  title: string;
  updatedAt: string;
}

/**
 * Open PRs in `repo` where the authenticated user's review is requested,
 * updated on or after `sinceIso`'s date. `gh pr list --search` takes the date
 * qualifier as a day (`updated:>=YYYY-MM-DD`), so the time-of-day component of
 * `sinceIso` is dropped rather than pretending to a precision the search
 * syntax does not offer.
 */
export function searchReviewRequestedPrs(
  key: RepoKey,
  sinceIso: string,
): ReviewRequestedPr[] {
  const day = sinceIso.slice(0, 10);
  // `gh pr list` takes the repo (and host, for GHE) as one `-R [HOST/]OWNER/REPO`
  // argument — unlike `gh api`, it has no separate `--hostname` flag.
  const repoArg =
    key.host && key.host !== "github.com"
      ? `${key.host}/${key.owner}/${key.repo}`
      : `${key.owner}/${key.repo}`;
  const raw = gh([
    "pr",
    "list",
    "-R",
    repoArg,
    "--search",
    `review-requested:@me updated:>=${day}`,
    "--state",
    "open",
    "--json",
    "number,title,updatedAt",
    "--limit",
    "100",
  ]);
  const parsed = JSON.parse(raw) as RawSearchPull[];
  return parsed.map((p) => ({ number: p.number, title: p.title, updatedAt: p.updatedAt }));
}

/* -------------------------------------------------- committed repo files */

interface RawContents {
  content?: string;
  encoding?: string;
  type?: string;
}

/* ------------------------------------------------------------ issue comments */

export interface IssueComment {
  id: number;
  body: string;
  htmlUrl: string;
  author?: string;
  createdAt: string;
  updatedAt: string;
}

interface RawIssueComment {
  id: number;
  body?: string;
  html_url: string;
  user?: { login?: string } | null;
  created_at: string;
  updated_at: string;
}

/**
 * A PR's conversation-tab comments (`issues/{n}/comments`, since a PR is an
 * issue as far as this endpoint is concerned) — the channel the analysis
 * sharing feature rides on, distinct from the line/file review comments the
 * rest of this module deals with. `--paginate` so a long-running PR's full
 * comment history is returned in one call.
 */
export function listIssueComments(key: PrKey): IssueComment[] {
  const raw = ghJson<RawIssueComment[]>(key.host, [
    "--paginate",
    `repos/${key.owner}/${key.repo}/issues/${key.number}/comments`,
  ]);
  return raw.map((c) => ({
    id: c.id,
    body: c.body ?? "",
    htmlUrl: c.html_url,
    author: c.user?.login ?? undefined,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  }));
}

/** `POST repos/{o}/{r}/issues/{n}/comments` — a new conversation-tab comment. */
export function postIssueComment(key: PrKey, body: string): IssueComment {
  const raw = ghJson<RawIssueComment>(
    key.host,
    [
      "--method",
      "POST",
      `repos/${key.owner}/${key.repo}/issues/${key.number}/comments`,
      "--input",
      "-",
    ],
    JSON.stringify({ body }),
  );
  return {
    id: raw.id,
    body: raw.body ?? "",
    htmlUrl: raw.html_url,
    author: raw.user?.login ?? undefined,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

/** `PATCH repos/{o}/{r}/issues/comments/{id}` — edits an existing conversation-tab comment. */
export function updateIssueComment(key: PrKey, commentId: number, body: string): IssueComment {
  const raw = ghJson<RawIssueComment>(
    key.host,
    [
      "--method",
      "PATCH",
      `repos/${key.owner}/${key.repo}/issues/comments/${commentId}`,
      "--input",
      "-",
    ],
    JSON.stringify({ body }),
  );
  return {
    id: raw.id,
    body: raw.body ?? "",
    htmlUrl: raw.html_url,
    author: raw.user?.login ?? undefined,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

/**
 * Read one file out of the target repo at a given ref, through
 * `gh api repos/{o}/{r}/contents/<path>?ref=<sha>`. Returns `null` when the
 * file does not exist (a 404 is the normal answer for a repo with no
 * `.purview/` directory) or when anything else goes wrong — the caller treats
 * "no committed config" and "could not read it" the same way.
 */
export function fetchRepoFile(
  key: PrKey,
  filePath: string,
  ref?: string,
): string | null {
  const suffix = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  try {
    const raw = JSON.parse(
      gh([
        "api",
        ...hostArgs(key.host),
        `repos/${key.owner}/${key.repo}/contents/${filePath}${suffix}`,
      ]),
    ) as RawContents;
    if (!raw || raw.type === "dir" || typeof raw.content !== "string") return null;
    if (raw.encoding && raw.encoding !== "base64") return raw.content;
    return Buffer.from(raw.content, "base64").toString("utf8");
  } catch {
    return null;
  }
}
