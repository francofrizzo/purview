import { execFileSync } from "node:child_process";
import type { PrKey } from "./paths.js";
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

function ghJson<T>(host: string, args: string[]): T {
  return JSON.parse(gh(["api", ...hostArgs(host), ...args])) as T;
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

/* -------------------------------------------------- committed repo files */

interface RawContents {
  content?: string;
  encoding?: string;
  type?: string;
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
