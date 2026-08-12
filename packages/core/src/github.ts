import { execFileSync } from "node:child_process";
import type { PrKey } from "./paths.js";

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
  state: string;
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
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
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
