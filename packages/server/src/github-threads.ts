import fs from "node:fs";
import path from "node:path";
import { commentsPath, gh, stateRoot, type PrKey } from "@reviewer/core";
import { readComments, type Comment } from "./comments.js";
import { ReviewError, classifyGhReviewError } from "./github-review.js";

/**
 * The PR's review threads as GitHub has them — everyone's, humans and AI
 * reviewers alike — so the web can show them inline next to Purview's own
 * comments. Read-mostly: the only writes are resolve/unresolve (replies are
 * ordinary drafts with `inReplyTo`, pushed by comment-sync.ts).
 *
 * GraphQL, not REST: only `pullRequest.reviewThreads` groups comments into
 * threads and carries resolution state (`isResolved`, `viewerCanResolve`…);
 * the REST comment listing has neither.
 *
 * The same call carries the PR's reviews (verdicts and their bodies) and its
 * conversation-tab comments — first 100 of each — for the summary strip.
 *
 * The last good fetch is cached as `threads.json` beside `comments.json`, so
 * an offline reader (or a gh hiccup) still sees the threads, flagged stale.
 */

/* ------------------------------------------------------------------ shapes */

/** Mirrors `RemoteAuthor` in packages/web/src/api/types.ts. */
export interface RemoteAuthor {
  login: string;
  bot: boolean;
  botName?: string;
  avatarUrl?: string;
}

/** Mirrors `RemoteComment` in packages/web/src/api/types.ts. */
export interface RemoteComment {
  id: string;
  databaseId: number;
  author: RemoteAuthor;
  body: string;
  createdAt: string;
  updatedAt?: string;
  url: string;
  reviewState: "PENDING" | "SUBMITTED";
  isMine: boolean;
  localId?: string;
}

/** Mirrors `RemoteThread` in packages/web/src/api/types.ts. */
export interface RemoteThread {
  id: string;
  path: string;
  subjectType: "line" | "file";
  line: number | null;
  originalLine: number | null;
  startLine: number | null;
  side: "LEFT" | "RIGHT";
  isResolved: boolean;
  isOutdated: boolean;
  resolvedBy?: string;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
  viewerCanReply: boolean;
  comments: RemoteComment[];
}

/** Mirrors `RemoteReview` in packages/web/src/api/types.ts. */
export interface RemoteReview {
  id: string;
  databaseId: number;
  author: RemoteAuthor;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
  body: string;
  submittedAt: string;
  url: string;
  commentCount: number;
  /** the head commit it was written against (absent on older caches) */
  commitOid?: string;
  isMine: boolean;
}

/** Mirrors `RemoteConversationComment` in packages/web/src/api/types.ts. */
export interface RemoteConversationComment {
  id: string;
  databaseId: number;
  author: RemoteAuthor;
  body: string;
  createdAt: string;
  updatedAt?: string;
  url: string;
  isMine: boolean;
}

/** GET /api/prs/:key/threads */
export interface ThreadsResponse {
  threads: RemoteThread[];
  reviews: RemoteReview[];
  conversation: RemoteConversationComment[];
  fetchedAt?: string;
  error?: string;
}

/** POST /api/prs/:key/threads/:id/resolve | /unresolve */
export interface ResolveThreadResult {
  thread: Pick<
    RemoteThread,
    "id" | "isResolved" | "resolvedBy" | "viewerCanResolve" | "viewerCanUnresolve"
  >;
}

/* ------------------------------------------------------------- bot naming */

/**
 * Display names for AI reviewers we know, keyed by lowercased login without
 * the `[bot]` suffix. GraphQL reports a Bot actor's login bare ("coderabbitai"),
 * REST and the web UI with the suffix — both reduce to the same key.
 */
const KNOWN_BOTS: Record<string, string> = {
  coderabbitai: "CodeRabbit",
  "copilot-pull-request-reviewer": "Copilot",
  copilot: "Copilot",
  "sourcery-ai": "Sourcery",
  "greptile-apps": "Greptile",
  cursor: "Cursor Bugbot",
  "gemini-code-assist": "Gemini",
  codex: "Codex",
  "chatgpt-codex-connector": "Codex",
  claude: "Claude",
};

/** `CodeRabbitAI[bot]` -> `coderabbitai`: the form logins are compared in. */
export function normalizeLogin(login: string): string {
  return login.trim().replace(/\[bot\]$/i, "").toLowerCase();
}

/**
 * GitHub's own verdict (a `Bot` actor, or a `[bot]` login) OR a login the
 * reader listed as an AI reviewer (`aiReviewers` in the global config) — some
 * AI reviewers post through ordinary user accounts.
 */
export function classifyAuthor(
  raw: { __typename?: string; login?: string; avatarUrl?: string } | null | undefined,
  aiReviewers: readonly string[] = [],
): RemoteAuthor {
  // A deleted account comes back as a null author; GitHub shows it as "ghost".
  const login = raw?.login ?? "ghost";
  const norm = normalizeLogin(login);
  const listed = aiReviewers.some((r) => normalizeLogin(r) === norm);
  const bot = raw?.__typename === "Bot" || /\[bot\]$/i.test(login) || listed;
  const botName = KNOWN_BOTS[norm];
  return {
    login,
    bot,
    ...(bot && botName ? { botName } : {}),
    ...(raw?.avatarUrl ? { avatarUrl: raw.avatarUrl } : {}),
  };
}

/* ----------------------------------------------------------------- GraphQL */

function hostArgs(host: string): string[] {
  return host && host !== "github.com" ? ["--hostname", host] : [];
}

export interface RawComment {
  id: string;
  databaseId: number;
  body: string;
  createdAt: string;
  lastEditedAt?: string | null;
  url: string;
  author?: { __typename?: string; login?: string; avatarUrl?: string } | null;
  pullRequestReview?: { state?: string } | null;
}

export interface RawConnection<T> {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  nodes?: (T | null)[];
}

export interface RawThread {
  id: string;
  path: string;
  line?: number | null;
  originalLine?: number | null;
  startLine?: number | null;
  diffSide?: string | null;
  subjectType?: string | null;
  isResolved?: boolean;
  isOutdated?: boolean;
  resolvedBy?: { login?: string } | null;
  viewerCanResolve?: boolean;
  viewerCanUnresolve?: boolean;
  viewerCanReply?: boolean;
  comments?: RawConnection<RawComment>;
}

export interface RawReview {
  id: string;
  databaseId: number;
  state?: string | null;
  body?: string | null;
  submittedAt?: string | null;
  createdAt?: string | null;
  url: string;
  author?: { __typename?: string; login?: string; avatarUrl?: string } | null;
  comments?: { totalCount?: number } | null;
  /** the head commit the review was written against */
  commit?: { oid?: string } | null;
}

export interface RawIssueComment {
  id: string;
  databaseId: number;
  body?: string | null;
  createdAt: string;
  lastEditedAt?: string | null;
  url: string;
  author?: { __typename?: string; login?: string; avatarUrl?: string } | null;
}

const COMMENT_FIELDS = `id databaseId body createdAt lastEditedAt url
  author{ __typename login avatarUrl }
  pullRequestReview{ state }`;

const THREADS_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$after:String){
  viewer{ login }
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewThreads(first:100,after:$after){
        pageInfo{ hasNextPage endCursor }
        nodes{
          id path line originalLine startLine diffSide subjectType
          isResolved isOutdated resolvedBy{ login }
          viewerCanResolve viewerCanUnresolve viewerCanReply
          comments(first:100){
            pageInfo{ hasNextPage endCursor }
            nodes{ ${COMMENT_FIELDS} }
          }
        }
      }
      reviews(first:100){
        nodes{
          id databaseId state body submittedAt createdAt url
          author{ __typename login avatarUrl }
          comments{ totalCount }
          commit{ oid }
        }
      }
      comments(first:100){
        nodes{
          id databaseId body createdAt lastEditedAt url
          author{ __typename login avatarUrl }
        }
      }
    }
  }
}`;

/** The rest of one thread's comments, past its first 100. */
const THREAD_COMMENTS_QUERY = `query($id:ID!,$after:String){
  node(id:$id){
    ... on PullRequestReviewThread{
      comments(first:100,after:$after){
        pageInfo{ hasNextPage endCursor }
        nodes{ ${COMMENT_FIELDS} }
      }
    }
  }
}`;

type GraphqlResponse<T> = { data?: T; errors?: { message?: string; type?: string }[] };

/**
 * One GraphQL call. Strings go through `-f` (never coerced), Ints through
 * `-F`, matching github-review.ts. A response carrying `errors` throws.
 */
function graphql<T>(
  key: PrKey,
  query: string,
  strings: Record<string, string | undefined>,
  ints: Record<string, number> = {},
): T {
  const args = ["api", "graphql", ...hostArgs(key.host), "-f", `query=${query}`];
  for (const [name, value] of Object.entries(strings)) {
    // An absent cursor is simply left out, i.e. null — the first page.
    if (value !== undefined) args.push("-f", `${name}=${value}`);
  }
  for (const [name, value] of Object.entries(ints)) args.push("-F", `${name}=${value}`);
  const res = JSON.parse(gh(args)) as GraphqlResponse<T>;
  if (res.errors?.length) {
    throw new Error(res.errors.map((e) => e.message).join("; "));
  }
  if (!res.data) throw new Error("GitHub returned no data");
  return res.data;
}

/** A thread's comments beyond what the threads page carried (rare: >100 in one thread). */
function remainingComments(key: PrKey, threadId: string, after: string): RawComment[] {
  const out: RawComment[] = [];
  let cursor: string | undefined = after;
  while (cursor) {
    const data: { node?: { comments?: RawConnection<RawComment> } | null } = graphql(
      key,
      THREAD_COMMENTS_QUERY,
      { id: threadId, after: cursor },
    );
    const conn: RawConnection<RawComment> | undefined = data.node?.comments;
    out.push(...((conn?.nodes ?? []).filter(Boolean) as RawComment[]));
    cursor = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor ?? undefined : undefined;
  }
  return out;
}

export interface RawThreadsPage {
  viewerLogin: string;
  threads: RawThread[];
  /** the first 100 only — rides along with the first threads page */
  reviews: RawReview[];
  /** the conversation tab's comments, the first 100 only */
  conversation: RawIssueComment[];
}

/**
 * Every review thread on the PR, every comment in each — paginated by 100 —
 * plus the first page of reviews and conversation comments from the same call.
 */
export function fetchRawThreads(key: PrKey): RawThreadsPage {
  const threads: RawThread[] = [];
  let reviews: RawReview[] = [];
  let conversation: RawIssueComment[] = [];
  let viewerLogin = "";
  let after: string | undefined;
  do {
    const firstPage = after === undefined;
    const data = graphql<{
      viewer?: { login?: string };
      repository?: {
        pullRequest?: {
          reviewThreads?: RawConnection<RawThread>;
          reviews?: RawConnection<RawReview> | null;
          comments?: RawConnection<RawIssueComment> | null;
        } | null;
      } | null;
    }>(
      key,
      THREADS_QUERY,
      { owner: key.owner, repo: key.repo, after },
      { number: key.number },
    );
    viewerLogin = data.viewer?.login ?? viewerLogin;
    const pr = data.repository?.pullRequest;
    const conn = pr?.reviewThreads;
    if (!conn) throw new Error(`No pull request ${key.owner}/${key.repo}#${key.number} on GitHub`);
    if (firstPage) {
      reviews = (pr.reviews?.nodes ?? []).filter(Boolean) as RawReview[];
      conversation = (pr.comments?.nodes ?? []).filter(Boolean) as RawIssueComment[];
    }
    for (const t of conn.nodes ?? []) {
      if (!t) continue;
      const cpage = t.comments?.pageInfo;
      if (cpage?.hasNextPage && cpage.endCursor) {
        t.comments = {
          nodes: [...(t.comments?.nodes ?? []), ...remainingComments(key, t.id, cpage.endCursor)],
        };
      }
      threads.push(t);
    }
    after = conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor ?? undefined : undefined;
  } while (after);
  return { viewerLogin, threads, reviews, conversation };
}

/* ------------------------------------------------------------ normalizing */

export interface NormalizeOptions {
  viewerLogin: string;
  aiReviewers?: readonly string[];
  /** comments.json, for `localId` */
  localComments?: readonly LocalForLink[];
}

/**
 * Raw GraphQL threads -> the wire shape. Drops comments sitting in someone
 * else's pending review (GitHub doesn't return those anyway, but a stray one
 * must never leak) and any thread left with no comments.
 */
export function normalizeThreads(raw: readonly RawThread[], opts: NormalizeOptions): RemoteThread[] {
  const viewer = opts.viewerLogin.toLowerCase();
  const out: RemoteThread[] = [];
  for (const t of raw) {
    const comments: RemoteComment[] = [];
    for (const c of t.comments?.nodes ?? []) {
      if (!c) continue;
      const author = classifyAuthor(c.author, opts.aiReviewers);
      const isMine = viewer !== "" && author.login.toLowerCase() === viewer;
      const pending = c.pullRequestReview?.state === "PENDING";
      if (pending && !isMine) continue;
      comments.push({
        id: c.id,
        databaseId: c.databaseId,
        author,
        body: c.body,
        createdAt: c.createdAt,
        ...(c.lastEditedAt ? { updatedAt: c.lastEditedAt } : {}),
        url: c.url,
        reviewState: pending ? "PENDING" : "SUBMITTED",
        isMine,
      });
    }
    if (comments.length === 0) continue;
    comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const fileLevel = t.subjectType === "FILE";
    out.push({
      id: t.id,
      path: t.path,
      subjectType: fileLevel ? "file" : "line",
      line: t.line ?? null,
      originalLine: t.originalLine ?? null,
      startLine: t.startLine ?? null,
      side: t.diffSide === "LEFT" ? "LEFT" : "RIGHT",
      isResolved: t.isResolved ?? false,
      isOutdated: t.isOutdated ?? false,
      ...(t.resolvedBy?.login ? { resolvedBy: t.resolvedBy.login } : {}),
      viewerCanResolve: t.viewerCanResolve ?? false,
      viewerCanUnresolve: t.viewerCanUnresolve ?? false,
      viewerCanReply: t.viewerCanReply ?? false,
      comments,
    });
  }
  return linkLocal(out, opts.localComments ?? []);
}

const REVIEW_STATES = new Set<RemoteReview["state"]>(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]);

/**
 * Raw GraphQL reviews -> the wire shape, oldest first. PENDING reviews (only
 * ever the viewer's own, unsubmitted) are left out: Purview shows its own
 * pending work as drafts.
 */
export function normalizeReviews(
  raw: readonly RawReview[],
  opts: Pick<NormalizeOptions, "viewerLogin" | "aiReviewers">,
): RemoteReview[] {
  const viewer = opts.viewerLogin.toLowerCase();
  const out: RemoteReview[] = [];
  for (const r of raw) {
    const state = r.state as RemoteReview["state"];
    if (!REVIEW_STATES.has(state)) continue;
    const author = classifyAuthor(r.author, opts.aiReviewers);
    out.push({
      id: r.id,
      databaseId: r.databaseId,
      author,
      state,
      body: r.body ?? "",
      submittedAt: r.submittedAt ?? r.createdAt ?? "",
      url: r.url,
      commentCount: r.comments?.totalCount ?? 0,
      ...(r.commit?.oid ? { commitOid: r.commit.oid } : {}),
      isMine: viewer !== "" && author.login.toLowerCase() === viewer,
    });
  }
  return out.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
}

/** Raw GraphQL issue comments (the conversation tab) -> the wire shape, oldest first. */
export function normalizeConversation(
  raw: readonly RawIssueComment[],
  opts: Pick<NormalizeOptions, "viewerLogin" | "aiReviewers">,
): RemoteConversationComment[] {
  const viewer = opts.viewerLogin.toLowerCase();
  return raw
    .map((c) => {
      const author = classifyAuthor(c.author, opts.aiReviewers);
      return {
        id: c.id,
        databaseId: c.databaseId,
        author,
        body: c.body ?? "",
        createdAt: c.createdAt,
        ...(c.lastEditedAt ? { updatedAt: c.lastEditedAt } : {}),
        url: c.url,
        isMine: viewer !== "" && author.login.toLowerCase() === viewer,
      };
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** What `linkLocal` needs of a Purview comment. */
export type LocalForLink = Pick<Comment, "id" | "githubCommentId"> &
  Partial<Pick<Comment, "file" | "line" | "body" | "status" | "subjectType">>;

/**
 * Point each remote comment at the Purview comment it mirrors, so the UI shows
 * that one card and never both. Recomputed on every read, cached or live:
 * comments.json moves independently of GitHub (a push, a discard).
 *
 * The REST databaseId recorded at push time is the match. Comments pushed
 * before that was recorded (or whose backfill failed) have none, so a sent
 * comment without one falls back to "mine, same file, same line, same text" —
 * the only way the same words could be on that line twice is if they are the
 * same comment.
 */
export function linkLocal(threads: RemoteThread[], localComments: readonly LocalForLink[]): RemoteThread[] {
  const byDbId = new Map<number, string>();
  const unlinked: LocalForLink[] = [];
  for (const c of localComments) {
    if (c.githubCommentId !== undefined) byDbId.set(c.githubCommentId, c.id);
    else if (c.status === "pushed" || c.status === "submitted") unlinked.push(c);
  }
  const taken = new Set<string>();
  return threads.map((t) => ({
    ...t,
    comments: t.comments.map((c) => {
      const { localId: _old, ...rest } = c;
      let localId = byDbId.get(c.databaseId);
      if (!localId && c.isMine) {
        const match = unlinked.find(
          (l) =>
            !taken.has(l.id) &&
            l.file === t.path &&
            (l.body ?? "").trim() === c.body.trim() &&
            (t.subjectType === "file"
              ? l.subjectType === "file"
              : l.line === t.line || l.line === t.originalLine),
        );
        if (match) {
          taken.add(match.id);
          localId = match.id;
        }
      }
      return localId ? { ...rest, localId } : rest;
    }),
  }));
}

/* ------------------------------------------------------------------- cache */

export function threadsPath(key: PrKey, root = stateRoot()): string {
  return path.join(path.dirname(commentsPath(key, root)), "threads.json");
}

interface ThreadsCache {
  threads: RemoteThread[];
  reviews: RemoteReview[];
  conversation: RemoteConversationComment[];
  fetchedAt: string;
}

export function readThreadsCache(key: PrKey, root = stateRoot()): ThreadsCache | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(threadsPath(key, root), "utf8")) as Partial<ThreadsCache>;
    if (!Array.isArray(raw.threads) || typeof raw.fetchedAt !== "string") return undefined;
    // Caches written before reviews/conversation were fetched lack both.
    return {
      threads: raw.threads,
      reviews: Array.isArray(raw.reviews) ? raw.reviews : [],
      conversation: Array.isArray(raw.conversation) ? raw.conversation : [],
      fetchedAt: raw.fetchedAt,
    };
  } catch {
    // Absent or corrupt: a cache, never load-bearing.
    return undefined;
  }
}

function writeThreadsCache(key: PrKey, cache: ThreadsCache, root = stateRoot()): void {
  const file = threadsPath(key, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cache, null, 2) + "\n", "utf8");
}

/* -------------------------------------------------------------------- API */

/**
 * Live from GitHub, falling back to the cached copy (with `error` set) when
 * gh fails — never a thrown error: threads are an overlay on the diff, and an
 * unreachable GitHub must not break the PR page.
 */
export function loadThreads(
  key: PrKey,
  opts: { root?: string; aiReviewers?: readonly string[] } = {},
): ThreadsResponse {
  const root = opts.root ?? stateRoot();
  let local: Comment[] = [];
  try {
    local = readComments(key, root);
  } catch {
    // An unreadable comments.json only costs the dedup links.
  }
  try {
    const raw = fetchRawThreads(key);
    const threads = normalizeThreads(raw.threads, {
      viewerLogin: raw.viewerLogin,
      aiReviewers: opts.aiReviewers,
      localComments: local,
    });
    const who = { viewerLogin: raw.viewerLogin, aiReviewers: opts.aiReviewers };
    const reviews = normalizeReviews(raw.reviews, who);
    const conversation = normalizeConversation(raw.conversation, who);
    const fetchedAt = new Date().toISOString();
    writeThreadsCache(key, { threads, reviews, conversation, fetchedAt }, root);
    return { threads, reviews, conversation, fetchedAt };
  } catch (err) {
    const e = classifyGhReviewError(err);
    const error =
      e.code === "gh_failed" ? `Could not load review threads from GitHub: ${errorText(err)}` : e.message;
    const cached = readThreadsCache(key, root);
    if (!cached) return { threads: [], reviews: [], conversation: [], error };
    return {
      threads: linkLocal(cached.threads, local),
      reviews: cached.reviews,
      conversation: cached.conversation,
      fetchedAt: cached.fetchedAt,
      error,
    };
  }
}

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // gh's message leads with the whole argv (the query included); keep the tail.
  const tail = raw.split(" failed: ").pop() ?? raw;
  return tail.length > 300 ? `${tail.slice(0, 300)}…` : tail;
}

const RESOLVE = (field: "resolveReviewThread" | "unresolveReviewThread") => `mutation($threadId:ID!){
  ${field}(input:{threadId:$threadId}){
    thread{ id isResolved resolvedBy{ login } viewerCanResolve viewerCanUnresolve }
  }
}`;

/**
 * Thread-specific failure modes first (a bad id, no permission), then the
 * shared review classifier. GraphQL reports both as `errors[]` with HTTP 200,
 * so they arrive here as plain messages.
 */
export function classifyThreadError(err: unknown): ReviewError {
  if (err instanceof ReviewError) return err;
  const raw = err instanceof Error ? err.message : String(err);
  if (/could not resolve to a node|NOT_FOUND/i.test(raw)) {
    return new ReviewError("thread_not_found", "That review thread no longer exists on GitHub", raw, 404);
  }
  if (/resource not accessible|does not have permission|FORBIDDEN|must have (push|write) access/i.test(raw)) {
    return new ReviewError(
      "thread_not_permitted",
      "GitHub does not allow you to change this thread's resolution",
      raw,
      403,
    );
  }
  return classifyGhReviewError(err);
}

/**
 * GraphQL `resolveReviewThread` / `unresolveReviewThread`, then the same
 * change patched into threads.json so a fallback read doesn't undo it.
 */
export function setThreadResolved(
  key: PrKey,
  threadId: string,
  resolved: boolean,
  root = stateRoot(),
): ResolveThreadResult {
  const field = resolved ? "resolveReviewThread" : "unresolveReviewThread";
  let thread: {
    id?: string;
    isResolved?: boolean;
    resolvedBy?: { login?: string } | null;
    viewerCanResolve?: boolean;
    viewerCanUnresolve?: boolean;
  } | null | undefined;
  try {
    const data = graphql<Record<string, { thread?: typeof thread } | null>>(key, RESOLVE(field), {
      threadId,
    });
    thread = data[field]?.thread;
  } catch (err) {
    throw classifyThreadError(err);
  }
  const result: ResolveThreadResult["thread"] = {
    id: thread?.id ?? threadId,
    isResolved: thread?.isResolved ?? resolved,
    ...(thread?.resolvedBy?.login ? { resolvedBy: thread.resolvedBy.login } : {}),
    viewerCanResolve: thread?.viewerCanResolve ?? !resolved,
    viewerCanUnresolve: thread?.viewerCanUnresolve ?? resolved,
  };

  const cached = readThreadsCache(key, root);
  if (cached) {
    const threads = cached.threads.map((t) => {
      if (t.id !== result.id) return t;
      const { resolvedBy: _r, ...rest } = t;
      return { ...rest, ...result };
    });
    writeThreadsCache(key, { ...cached, threads }, root);
  }
  return { thread: result };
}
