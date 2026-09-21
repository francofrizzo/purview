import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  githubUserCachePath,
  repoGithubCachePath,
  stateRoot,
  type PrKey,
  type RepoKey,
} from "./paths.js";
import type { BasePr, PrState, ReviewDecision, ReviewRequest } from "./schemas.js";

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

/**
 * The non-blocking twin of `gh`, for background work that must not stall the
 * server's event loop. An injected runner (tests) is honoured, still resolved
 * asynchronously so callers see the same shape either way.
 */
export function ghAsync(args: string[], input?: string): Promise<string> {
  if (runner !== defaultRunner) {
    const injected = runner;
    return Promise.resolve().then(() => injected(args, input));
  }
  return new Promise((resolve, reject) => {
    const child = execFile(
      "gh",
      args,
      { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || stdout || err.message || "").toString().trim();
          reject(new Error(`gh ${args.join(" ")} failed: ${detail}`));
        } else {
          resolve(stdout);
        }
      },
    );
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

function hostArgs(host: string): string[] {
  // gh defaults to github.com; GHE hosts need an explicit --hostname.
  return host && host !== "github.com" ? ["--hostname", host] : [];
}

/**
 * `gh pr list` takes the repo (and host, for GHE) as one `-R [HOST/]OWNER/REPO`
 * argument — unlike `gh api`, it has no separate `--hostname` flag.
 */
function repoFlagValue(key: RepoKey): string {
  return key.host && key.host !== "github.com"
    ? `${key.host}/${key.owner}/${key.repo}`
    : `${key.owner}/${key.repo}`;
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
  const raw = gh([
    "pr",
    "list",
    "-R",
    repoFlagValue(key),
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

/* ------------------------------------------------------- repo default branch */

/** How long a cached default branch is trusted before it is re-read. */
export const DEFAULT_BRANCH_TTL_MS = 24 * 60 * 60_000;
/** A failed lookup is not retried (in this process) for this long. */
const DEFAULT_BRANCH_FAILURE_TTL_MS = 5 * 60_000;

interface DefaultBranchEntry {
  /** `null` = never successfully read. */
  defaultBranch: string | null;
  fetchedAt: number;
  /** When the last lookup failed (memory only, never on disk). */
  failedAt?: number;
}

const defaultBranchMemo = new Map<string, DefaultBranchEntry>();
const memoKey = (key: RepoKey, root: string) =>
  `${root}|${key.host}/${key.owner}/${key.repo}`;

/** Tests: forget every in-memory default branch. */
export function clearDefaultBranchCache(): void {
  defaultBranchMemo.clear();
}

function readDefaultBranchFile(key: RepoKey, root: string): DefaultBranchEntry | null {
  try {
    const raw = JSON.parse(fs.readFileSync(repoGithubCachePath(key, root), "utf8")) as {
      defaultBranch?: unknown;
      fetchedAt?: unknown;
    };
    if (typeof raw.defaultBranch !== "string" || raw.defaultBranch === "") return null;
    const at = typeof raw.fetchedAt === "string" ? Date.parse(raw.fetchedAt) : NaN;
    return { defaultBranch: raw.defaultBranch, fetchedAt: Number.isFinite(at) ? at : 0 };
  } catch {
    return null;
  }
}

/**
 * The repo's default branch from cache alone — memory, then disk — ignoring
 * the TTL and never calling `gh`. For prompt builders, which must not block on
 * the network: a stale answer is still the right answer almost always, and no
 * answer means "unknown".
 */
export function cachedDefaultBranch(key: RepoKey, root = stateRoot()): string | null {
  const hit = defaultBranchMemo.get(memoKey(key, root));
  if (hit?.defaultBranch) return hit.defaultBranch;
  const file = readDefaultBranchFile(key, root);
  if (file) defaultBranchMemo.set(memoKey(key, root), file);
  return file?.defaultBranch ?? null;
}

/**
 * `gh api repos/{o}/{r}` → `default_branch`, cached per repo in memory and in
 * `github-cache.json` for `DEFAULT_BRANCH_TTL_MS`. Never throws: on any failure
 * it answers with the last known value (however old), else `null` ("unknown").
 */
export function fetchDefaultBranch(
  key: RepoKey,
  root = stateRoot(),
  now: number = Date.now(),
): string | null {
  const mk = memoKey(key, root);
  const hit = defaultBranchMemo.get(mk) ?? readDefaultBranchFile(key, root);
  if (hit) {
    defaultBranchMemo.set(mk, hit);
    if (hit.defaultBranch && now - hit.fetchedAt < DEFAULT_BRANCH_TTL_MS) return hit.defaultBranch;
    if (hit.failedAt !== undefined && now - hit.failedAt < DEFAULT_BRANCH_FAILURE_TTL_MS) {
      return hit.defaultBranch;
    }
  }
  try {
    const raw = ghJson<{ default_branch?: unknown }>(key.host, [
      `repos/${key.owner}/${key.repo}`,
    ]);
    const branch = raw?.default_branch;
    if (typeof branch !== "string" || branch === "") throw new Error("no default_branch");
    const entry = { defaultBranch: branch, fetchedAt: now };
    defaultBranchMemo.set(mk, entry);
    try {
      const file = repoGithubCachePath(key, root);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        JSON.stringify({ defaultBranch: branch, fetchedAt: new Date(now).toISOString() }, null, 2) +
          "\n",
        "utf8",
      );
    } catch {
      // An unwritable cache only costs a re-read next time.
    }
    return branch;
  } catch {
    // Remember the failure briefly so a broken `gh` isn't hammered, and keep
    // serving the last known (if stale) value meanwhile.
    const stale = hit?.defaultBranch ?? null;
    defaultBranchMemo.set(mk, {
      defaultBranch: stale,
      fetchedAt: hit?.fetchedAt ?? 0,
      failedAt: now,
    });
    return stale;
  }
}

/* ---------------------------------------------------- viewer login & teams */

/** A failed login/teams lookup is not retried (in this process) for this long. */
const VIEWER_FAILURE_TTL_MS = 5 * 60_000;
/** Team membership is re-read this often (memory only; it does change). */
export const VIEWER_TEAMS_TTL_MS = 6 * 60 * 60_000;

interface LoginEntry {
  login: string | null;
  failedAt?: number;
}

const loginMemo = new Map<string, LoginEntry>();
const loginInflight = new Map<string, Promise<string | null>>();
const viewerKey = (host: string, root: string) => `${root}|${host}`;

interface TeamsEntry {
  /** `{ slug, org }` for every team the user is in on this host. */
  teams: { slug: string; org: string }[];
  fetchedAt: number;
}

const teamsMemo = new Map<string, TeamsEntry>();
const teamsInflight = new Map<string, Promise<TeamsEntry>>();

/** Tests: forget the in-memory login and team caches. */
export function clearViewerCache(): void {
  loginMemo.clear();
  loginInflight.clear();
  teamsMemo.clear();
  teamsInflight.clear();
}

function readLoginFile(host: string, root: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(githubUserCachePath(root), "utf8")) as Record<
      string,
      { login?: unknown } | undefined
    >;
    const login = raw?.[host]?.login;
    return typeof login === "string" && login !== "" ? login : null;
  } catch {
    return null;
  }
}

function writeLoginFile(host: string, root: string, login: string, now: number): void {
  try {
    const file = githubUserCachePath(root);
    let data: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      }
    } catch {
      // absent or unreadable: start over
    }
    data[host] = { login, fetchedAt: new Date(now).toISOString() };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
  } catch {
    // An unwritable cache only costs a re-read next process.
  }
}

/** The cached answer, or `undefined` when `gh` has to be asked. */
function cachedLogin(host: string, root: string, now: number): string | null | undefined {
  const mk = viewerKey(host, root);
  const hit = loginMemo.get(mk);
  if (hit?.login) return hit.login;
  if (hit?.failedAt !== undefined && now - hit.failedAt < VIEWER_FAILURE_TTL_MS) return null;
  const file = readLoginFile(host, root);
  if (file) {
    loginMemo.set(mk, { login: file });
    return file;
  }
  return undefined;
}

function settleLogin(host: string, root: string, raw: string | Error, now: number): string | null {
  let login = "";
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as { login?: unknown };
      if (typeof parsed?.login === "string") login = parsed.login.trim();
    } catch {
      // not JSON: no login
    }
  }
  if (login === "") {
    loginMemo.set(viewerKey(host, root), { login: null, failedAt: now });
    return null;
  }
  loginMemo.set(viewerKey(host, root), { login });
  writeLoginFile(host, root, login, now);
  return login;
}

/** Plain `gh api user` (the JSON's `.login` is read here, not with `-q`). */
const loginArgs = (host: string) => ["api", ...hostArgs(host), "user"];

/**
 * The authenticated `gh` user's login on `host` (`gh api user` → `.login`),
 * cached for the process and in `github-user.json`: it never changes in
 * practice. `null` when it cannot be read; never throws.
 */
export function viewerLogin(host: string, root = stateRoot(), now = Date.now()): string | null {
  const hit = cachedLogin(host, root, now);
  if (hit !== undefined) return hit;
  let raw: string | Error;
  try {
    raw = gh(loginArgs(host));
  } catch (err) {
    raw = err as Error;
  }
  return settleLogin(host, root, raw, now);
}

/** `viewerLogin` without blocking the event loop; concurrent callers share one `gh`. */
export function viewerLoginAsync(
  host: string,
  root = stateRoot(),
  now = Date.now(),
): Promise<string | null> {
  const hit = cachedLogin(host, root, now);
  if (hit !== undefined) return Promise.resolve(hit);
  const mk = viewerKey(host, root);
  const pending = loginInflight.get(mk);
  if (pending) return pending;
  const p = ghAsync(loginArgs(host))
    .then(
      (out) => settleLogin(host, root, out, now),
      (err: Error) => settleLogin(host, root, err, now),
    )
    .finally(() => loginInflight.delete(mk));
  loginInflight.set(mk, p);
  return p;
}

const teamsArgs = (host: string) => [
  "api",
  ...hostArgs(host),
  "--paginate",
  "user/teams?per_page=100",
  "--jq",
  ".[] | {slug: .slug, org: .organization.login}",
];

/** JSON-lines `{slug, org}` → entries; unparseable lines are skipped. */
function parseTeams(out: string): { slug: string; org: string }[] {
  const teams: { slug: string; org: string }[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    try {
      const t = JSON.parse(line) as { slug?: unknown; org?: unknown };
      if (typeof t.slug === "string" && typeof t.org === "string") {
        teams.push({ slug: t.slug, org: t.org });
      }
    } catch {
      // skip
    }
  }
  return teams;
}

const teamsFor = (entry: TeamsEntry, org: string) =>
  entry.teams.filter((t) => t.org.toLowerCase() === org.toLowerCase()).map((t) => t.slug);

function freshTeams(host: string, root: string, now: number): TeamsEntry | undefined {
  const hit = teamsMemo.get(viewerKey(host, root));
  if (!hit) return undefined;
  // An empty answer (usually: the token lacks `read:org`) is retried sooner.
  const ttl = hit.teams.length > 0 ? VIEWER_TEAMS_TTL_MS : VIEWER_FAILURE_TTL_MS * 12;
  return now - hit.fetchedAt < ttl ? hit : undefined;
}

/**
 * Slugs of the user's teams in `org` (`gh api user/teams`), cached in memory.
 * A failure — typically a token without `read:org` — or an empty answer means
 * "no teams": team requests are then simply not recognised as the user's.
 * Never throws.
 */
export function viewerTeams(
  host: string,
  org: string,
  root = stateRoot(),
  now = Date.now(),
): string[] {
  const hit = freshTeams(host, root, now);
  if (hit) return teamsFor(hit, org);
  let teams: { slug: string; org: string }[] = [];
  try {
    teams = parseTeams(gh(teamsArgs(host)));
  } catch {
    // no scope / no network: no teams
  }
  const entry = { teams, fetchedAt: now };
  teamsMemo.set(viewerKey(host, root), entry);
  return teamsFor(entry, org);
}

/** `viewerTeams` without blocking the event loop. */
export async function viewerTeamsAsync(
  host: string,
  org: string,
  root = stateRoot(),
  now = Date.now(),
): Promise<string[]> {
  const hit = freshTeams(host, root, now);
  if (hit) return teamsFor(hit, org);
  const mk = viewerKey(host, root);
  let pending = teamsInflight.get(mk);
  if (!pending) {
    pending = ghAsync(teamsArgs(host))
      .then(parseTeams, () => [] as { slug: string; org: string }[])
      .then((teams) => {
        const entry = { teams, fetchedAt: now };
        teamsMemo.set(mk, entry);
        return entry;
      })
      .finally(() => teamsInflight.delete(mk));
    teamsInflight.set(mk, pending);
  }
  return teamsFor(await pending, org);
}

/* --------------------------------------------------------- review request */

/** The subset of an issue-timeline event `foldReviewRequest` reads. */
export interface TimelineEvent {
  event?: string | null;
  created_at?: string | null;
  submitted_at?: string | null;
  state?: string | null;
  user?: { login?: string | null } | null;
  requested_reviewer?: { login?: string | null } | null;
  requested_team?: { slug?: string | null } | null;
  review_requester?: { login?: string | null } | null;
}

const eq = (a: string | null | undefined, b: string) =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * Fold a PR's issue timeline into the user's pending review request, or
 * `null`. Each target (the user directly, or one of `teams`) is tracked on its
 * own: a `review_requested` for it opens a request, a `review_request_removed`
 * for it closes that one, and a submitted `reviewed` by the user closes all of
 * them — so a re-request after a review opens a fresh one ("waiting on me
 * since"). Of the requests left open, the latest wins. Other people's events
 * are ignored, and the input need not be in order.
 */
export function foldReviewRequest(
  events: TimelineEvent[],
  login: string,
  teams: string[] = [],
): ReviewRequest | null {
  const targetOf = (e: TimelineEvent): string | null => {
    if (eq(e.requested_reviewer?.login, login)) return "you";
    const slug = e.requested_team?.slug;
    if (typeof slug === "string" && teams.some((t) => eq(slug, t))) return `team:${slug}`;
    return null;
  };

  const timed = events
    .map((e, i) => {
      const stamp = e.event === "reviewed" ? e.submitted_at ?? e.created_at : e.created_at;
      return { e, i, stamp: stamp ?? "", t: Date.parse(stamp ?? "") };
    })
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t || a.i - b.i);

  const open = new Map<string, ReviewRequest & { t: number }>();
  for (const { e, stamp, t } of timed) {
    if (e.event === "review_requested") {
      const target = targetOf(e);
      if (target) open.set(target, { at: stamp, by: e.review_requester?.login ?? "", via: target, t });
    } else if (e.event === "review_request_removed") {
      const target = targetOf(e);
      if (target) open.delete(target);
    } else if (e.event === "reviewed") {
      // A pending (unsubmitted) review has not answered anything yet.
      if (eq(e.user?.login, login) && !eq(e.state, "pending")) open.clear();
    }
  }

  let latest: (ReviewRequest & { t: number }) | null = null;
  for (const r of open.values()) if (!latest || r.t > latest.t) latest = r;
  return latest ? { at: latest.at, by: latest.by, via: latest.via } : null;
}

/** Only the three event kinds that matter, trimmed to the fields read above. */
const TIMELINE_JQ =
  '.[] | select(.event == "review_requested" or .event == "review_request_removed" or .event == "reviewed")' +
  " | {event, created_at, submitted_at, state," +
  " user: {login: .user.login}," +
  " requested_reviewer: {login: .requested_reviewer.login}," +
  " requested_team: {slug: .requested_team.slug}," +
  " review_requester: {login: .review_requester.login}}";

const timelineArgs = (key: PrKey) => [
  "api",
  ...hostArgs(key.host),
  "--paginate",
  `repos/${key.owner}/${key.repo}/issues/${key.number}/timeline?per_page=100`,
  "--jq",
  TIMELINE_JQ,
];

/** `--jq` prints one compact JSON object per line, across every page. */
function parseTimeline(out: string): TimelineEvent[] {
  return out
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as TimelineEvent);
}

/**
 * The user's pending review request on `key` (see `foldReviewRequest`), from
 * one paginated timeline fetch. `undefined` when the fetch failed, so callers
 * keep whatever they knew before.
 */
export function fetchReviewRequest(
  key: PrKey,
  login: string,
  teams: string[] = [],
): ReviewRequest | null | undefined {
  try {
    return foldReviewRequest(parseTimeline(gh(timelineArgs(key))), login, teams);
  } catch {
    return undefined;
  }
}

/** `fetchReviewRequest` without blocking the event loop. */
export async function fetchReviewRequestAsync(
  key: PrKey,
  login: string,
  teams: string[] = [],
): Promise<ReviewRequest | null | undefined> {
  try {
    return foldReviewRequest(parseTimeline(await ghAsync(timelineArgs(key))), login, teams);
  } catch {
    return undefined;
  }
}

/**
 * Login + teams + timeline in one: the pending request for whoever `gh` is
 * authenticated as. `undefined` when any of it could not be determined.
 */
export function resolveReviewRequest(
  key: PrKey,
  root = stateRoot(),
): ReviewRequest | null | undefined {
  const login = viewerLogin(key.host, root);
  if (!login) return undefined;
  return fetchReviewRequest(key, login, viewerTeams(key.host, key.owner, root));
}

/** `resolveReviewRequest` without blocking the event loop. */
export async function resolveReviewRequestAsync(
  key: PrKey,
  root = stateRoot(),
): Promise<ReviewRequest | null | undefined> {
  const login = await viewerLoginAsync(key.host, root);
  if (!login) return undefined;
  const teams = await viewerTeamsAsync(key.host, key.owner, root);
  return fetchReviewRequestAsync(key, login, teams);
}

/* ------------------------------------------------------ PR by head branch */

/**
 * The open PR whose head branch is `head` (`gh pr list --head`), used to name
 * the PR a stacked PR sits on. `null` when there is none; `undefined` when the
 * lookup itself failed, so the caller can keep what it already knew.
 */
export function findOpenPrByHead(key: RepoKey, head: string): BasePr | null | undefined {
  try {
    const raw = gh([
      "pr",
      "list",
      "--repo",
      repoFlagValue(key),
      "--head",
      head,
      "--state",
      "open",
      "--json",
      "number,title,url",
      "--limit",
      "1",
    ]);
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const first = parsed[0] as { number?: unknown; title?: unknown; url?: unknown } | undefined;
    if (!first) return null;
    if (typeof first.number !== "number" || typeof first.url !== "string") return undefined;
    return {
      number: first.number,
      title: typeof first.title === "string" ? first.title : "",
      url: first.url,
    };
  } catch {
    return undefined;
  }
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
