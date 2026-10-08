/**
 * GitHub review threads merged with Purview's own comments, the way the diff
 * reads them.
 *
 * Two sources describe overlapping things: comments.json (what this reader
 * wrote here, whatever its status) and the PR's review threads as GitHub has
 * them (everyone's, including the copies of what Purview pushed). This folds
 * them into one list of display threads per line anchor and per file, so each
 * comment shows up exactly once:
 *
 *  - a remote comment that mirrors a local one (`localId`, or a matching
 *    `githubCommentId`) is drawn as the local card, in the remote's slot;
 *  - a local reply (`inReplyTo`) joins the end of its thread, wherever its own
 *    anchor says;
 *  - every other local comment stands alone, exactly as before threads.
 *
 * Pure functions only; the diff calls this once per change, never per row.
 */

import {
  isFileComment,
  type CommentStatus,
  type DraftComment,
  type RemoteAuthor,
  type RemoteComment,
  type RemoteThread,
} from "../api/types";
import { attentionStatus, bubbleTitle, lineAnchor } from "./comments";

export type ThreadItem =
  | { kind: "local"; comment: DraftComment }
  | { kind: "remote"; comment: RemoteComment };

/** Whose comment it is, as far as display and filtering care. */
export type AuthorKind = "you" | "person" | "bot";

export interface ThreadAuthor {
  kind: AuthorKind;
  /** GitHub login; absent for a Purview comment that is not on GitHub */
  login?: string;
  /** for bots: the lowercased login without "[bot]" (what the hide list holds) */
  botKey?: string;
  /** "CodeRabbit", "@maria", "you" */
  name: string;
}

/**
 * Where a thread is drawn. "line" hangs off its line; everything else goes in
 * its file's block, labelled: a whole-file thread, an outdated one (the code
 * it was written on changed), or one whose line this diff does not show.
 */
export type ThreadPlacement = "line" | "file" | "outdated" | "off-diff";

export interface DisplayThread {
  /** the GitHub thread id, or `local:<id>` for a standalone Purview comment */
  key: string;
  /** null for a standalone Purview comment */
  remote: RemoteThread | null;
  /** root first, then replies (local reply drafts last) */
  items: ThreadItem[];
  resolved: boolean;
  placement: ThreadPlacement;
  /** the root's author */
  author: ThreadAuthor;
}

/** What the reader chose to see (persisted in web settings). */
export interface ThreadFilters {
  /** off: resolved threads leave the diff entirely (on: they show collapsed) */
  showResolved: boolean;
  /** off: every thread an AI reviewer started is hidden */
  showAiReviewers: boolean;
  /** bot keys (see {@link botKey}) whose threads are hidden */
  hiddenBots: readonly string[];
}

export const DEFAULT_THREAD_FILTERS: ThreadFilters = {
  showResolved: true,
  showAiReviewers: true,
  hiddenBots: [],
};

export interface ThreadGroups {
  /** keyed by {@link lineAnchor} */
  byLine: Map<string, DisplayThread[]>;
  /** keyed by path: file-level, outdated and off-diff threads, plus file comments */
  byFile: Map<string, DisplayThread[]>;
  /** where each shown GitHub thread landed, by thread id */
  located: Map<string, { anchor: string } | { file: string }>;
  /** GitHub threads the filters hid */
  hidden: number;
}

/** "coderabbitai[bot]" → "coderabbitai": one key for a bot however GitHub spells it. */
export function botKey(login: string): string {
  return login.replace(/\[bot\]$/i, "").toLowerCase();
}

export function authorOf(item: ThreadItem): ThreadAuthor {
  if (item.kind === "local") return { kind: "you", name: "you" };
  const { author, isMine } = item.comment;
  if (isMine) return { kind: "you", login: author.login, name: "you" };
  if (author.bot) {
    return {
      kind: "bot",
      login: author.login,
      botKey: botKey(author.login),
      name: author.botName ?? author.login.replace(/\[bot\]$/i, ""),
    };
  }
  return { kind: "person", login: author.login, name: `@${author.login}` };
}

export function itemTime(item: ThreadItem): string | undefined {
  return item.comment.createdAt;
}

function hasDraft(items: ThreadItem[]): boolean {
  return items.some((i) => i.kind === "local" && (i.comment.status ?? "draft") === "draft");
}

/**
 * Whether the filters hide a thread. A thread holding one of the reader's
 * unsent drafts never hides: that is work they still have to do something with.
 */
export function isThreadHidden(thread: DisplayThread, filters: ThreadFilters): boolean {
  if (!thread.remote || hasDraft(thread.items)) return false;
  if (thread.resolved && !filters.showResolved) return true;
  if (thread.author.kind === "bot") {
    if (!filters.showAiReviewers) return true;
    if (thread.author.botKey && filters.hiddenBots.includes(thread.author.botKey)) return true;
  }
  return false;
}

/** Is a GitHub thread's root an AI reviewer the filters hide? (The drawer's bot groups.) */
export function isBotHidden(key: string, filters: ThreadFilters): boolean {
  return !filters.showAiReviewers || filters.hiddenBots.includes(key);
}

function placementOf(
  t: RemoteThread,
  inDiff?: (file: string, line: number, side: "LEFT" | "RIGHT") => boolean,
): ThreadPlacement {
  if (t.subjectType === "file") return "file";
  if (t.line === null || t.isOutdated) return "outdated";
  if (inDiff && !inDiff(t.path, t.line, t.side)) return "off-diff";
  return "line";
}

export function buildThreadGroups({
  comments,
  threads = [],
  filters = DEFAULT_THREAD_FILTERS,
  inDiff,
}: {
  comments: DraftComment[];
  threads?: RemoteThread[];
  filters?: ThreadFilters;
  /** is this line in the diff? A thread on one that is not goes to its file's block. */
  inDiff?: (file: string, line: number, side: "LEFT" | "RIGHT") => boolean;
}): ThreadGroups {
  const byLine = new Map<string, DisplayThread[]>();
  const byFile = new Map<string, DisplayThread[]>();
  const located = new Map<string, { anchor: string } | { file: string }>();
  let hidden = 0;

  const localById = new Map(comments.map((c) => [c.id, c]));
  const localByGithubId = new Map<number, DraftComment>();
  for (const c of comments) if (c.githubCommentId !== undefined) localByGithubId.set(c.githubCommentId, c);
  const consumed = new Set<string>();
  const take = (c: DraftComment | undefined): DraftComment | undefined => {
    if (!c || consumed.has(c.id)) return undefined;
    consumed.add(c.id);
    return c;
  };

  const remoteThreads: DisplayThread[] = [];
  for (const t of threads) {
    if (t.comments.length === 0) continue;
    const items: ThreadItem[] = t.comments.map((rc) => {
      const local = take((rc.localId ? localById.get(rc.localId) : undefined) ?? localByGithubId.get(rc.databaseId));
      return local ? { kind: "local", comment: local } : { kind: "remote", comment: rc };
    });
    // The thread a Purview comment started, but the mirror was not matched
    // (the server had no id to match on yet): the reader's root is that comment.
    const root = items[0];
    if (root.kind === "remote" && root.comment.isMine) {
      const starter = comments.find((c) => c.githubThreadId === t.id && !c.inReplyTo && !consumed.has(c.id));
      if (starter) {
        consumed.add(starter.id);
        items[0] = { kind: "local", comment: starter };
      }
    }
    for (const c of comments) {
      if (c.inReplyTo === t.id && take(c)) items.push({ kind: "local", comment: c });
    }
    remoteThreads.push({
      key: t.id,
      remote: t,
      items,
      resolved: t.isResolved,
      placement: placementOf(t, inDiff),
      author: authorOf(items[0]),
    });
  }

  const push = <K>(map: Map<K, DisplayThread[]>, key: K, thread: DisplayThread) => {
    const list = map.get(key);
    if (list) list.push(thread);
    else map.set(key, [thread]);
  };

  for (const thread of remoteThreads) {
    if (isThreadHidden(thread, filters)) {
      hidden++;
      continue;
    }
    const t = thread.remote!;
    if (thread.placement === "line") {
      const anchor = lineAnchor(t.path, t.line as number, t.side);
      push(byLine, anchor, thread);
      located.set(t.id, { anchor });
    } else {
      push(byFile, t.path, thread);
      located.set(t.id, { file: t.path });
    }
  }

  for (const c of comments) {
    if (consumed.has(c.id)) continue;
    const thread: DisplayThread = {
      key: `local:${c.id}`,
      remote: null,
      items: [{ kind: "local", comment: c }],
      resolved: false,
      placement: isFileComment(c) ? "file" : "line",
      author: { kind: "you", name: "you" },
    };
    if (isFileComment(c)) push(byFile, c.file, thread);
    // Defensive: a line comment without a side is anchored the way GitHub
    // anchors context lines.
    else push(byLine, lineAnchor(c.file, c.line as number, c.side ?? "RIGHT"), thread);
  }

  // Oldest first within a bucket. Array.sort is stable, so ties (and local
  // comments without a timestamp, which sort last) keep their incoming order.
  const byTime = (a: DisplayThread, b: DisplayThread) => {
    const ta = itemTime(a.items[0]) ?? "￿";
    const tb = itemTime(b.items[0]) ?? "￿";
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  };
  for (const list of byLine.values()) list.sort(byTime);
  for (const list of byFile.values()) list.sort(byTime);

  return { byLine, byFile, located, hidden };
}

/** Every Purview comment the threads hold, in display order. */
export function localComments(threads: DisplayThread[]): DraftComment[] {
  const out: DraftComment[] = [];
  for (const t of threads) for (const i of t.items) if (i.kind === "local") out.push(i.comment);
  return out;
}

export function itemCount(threads: DisplayThread[]): number {
  return threads.reduce((n, t) => n + t.items.length, 0);
}

/**
 * How a marker paints: a Purview status when the reader has comments there
 * (the one that still needs them), else a neutral "remote" look for other
 * people's threads, or a bot tint when every thread there is an AI reviewer's.
 */
export type MarkerLook = CommentStatus | "remote" | "bot";

export interface MarkerSummary {
  count: number;
  look: MarkerLook;
  /** every thread there is resolved: the marker steps back */
  resolved: boolean;
}

export function threadMarker(threads: DisplayThread[]): MarkerSummary {
  const local = localComments(threads);
  const look: MarkerLook = local.length
    ? attentionStatus(local)
    : threads.length && threads.every((t) => t.author.kind === "bot")
      ? "bot"
      : "remote";
  return {
    count: itemCount(threads),
    look,
    resolved: threads.length > 0 && threads.every((t) => t.resolved),
  };
}

/** The marker's tooltip. Purview-only lines keep their old wording. */
export function threadsTitle(threads: DisplayThread[]): string {
  const remote = threads.filter((t) => t.remote);
  if (remote.length === 0) return bubbleTitle(localComments(threads));
  const n = itemCount(threads);
  const resolved = remote.filter((t) => t.resolved).length;
  const parts = [`${n} ${n === 1 ? "comment" : "comments"}`];
  parts.push(`${threads.length} ${threads.length === 1 ? "thread" : "threads"}`);
  if (resolved) parts.push(resolved === remote.length && remote.length === threads.length ? "resolved" : `${resolved} resolved`);
  const authors = [...new Set(remote.map((t) => t.author.name))];
  const by = authors.length <= 2 ? ` by ${authors.join(" and ")}` : "";
  return `${parts.join(" · ")}${by} — click to ${n === 1 ? "read it" : "read them"}`;
}

/** What "Reply" opens the composer on: the thread's own place, plus the thread. */
export type ReplyTarget =
  | { subjectType: "line"; file: string; line: number; side: "LEFT" | "RIGHT"; inReplyTo: string; replyTo: string }
  | { subjectType: "file"; file: string; inReplyTo: string; replyTo: string };

export function replyTarget(thread: DisplayThread): ReplyTarget | null {
  const t = thread.remote;
  if (!t) return null;
  const replyTo = thread.author.name;
  const line = t.line ?? t.originalLine;
  if (t.subjectType === "file" || line === null) return { subjectType: "file", file: t.path, inReplyTo: t.id, replyTo };
  return { subjectType: "line", file: t.path, line, side: t.side, inReplyTo: t.id, replyTo };
}

/** GitHub bodies carry HTML comments (CodeRabbit's bookkeeping): never show them. */
export function cleanRemoteBody(body: string): string {
  return body.replace(/<!--[\s\S]*?(-->|$)/g, "").trim();
}

/**
 * An AI reviewer's italic tag line, e.g. CodeRabbit's
 * `_🩺 Stability & Availability_ | _🟠 Major_ | _⚡ Quick win_` (category,
 * severity, effort) or the older `_⚠️ Potential issue_ | _🟠 Major_`.
 */
const ITALIC_HEADER = /^_[^_\n]+_(\s*\|\s*_[^_\n]+_)*\s*$/;

/**
 * Split a leading tag line off a body: the card shows the tags as chips and
 * renders the rest as markdown. A body without one comes back untouched.
 */
export function splitReviewTags(body: string): { tags: string[]; body: string } {
  const text = body.replace(/^\s+/, "");
  const nl = text.indexOf("\n");
  const first = (nl === -1 ? text : text.slice(0, nl)).trim();
  if (nl === -1 || !ITALIC_HEADER.test(first)) return { tags: [], body };
  const tags = first.split("|").map((t) => t.trim().replace(/^_|_$/g, "").trim()).filter(Boolean);
  return { tags, body: text.slice(nl + 1).replace(/^\s*\n/, "") };
}

const plain = (text: string) =>
  text
    .replace(/<[^>]+>/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The first words of a body, as plain text: for one-line summaries (a
 * resolved thread, a drawer row). Code, collapsibles and markup drop out;
 * a body that is nothing but collapsibles falls back to their text.
 */
export function excerpt(body: string, max = 80): string {
  const content = splitReviewTags(cleanRemoteBody(body)).body.replace(/```[\s\S]*?(```|$)/g, " ");
  const text = plain(content.replace(/<details[\s\S]*?<\/details>/gi, " ")) || plain(content);
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** "@maria: Why retry here rather than…" */
export function threadSummary(thread: DisplayThread, max = 70): string {
  return `${thread.author.name}: ${excerpt(thread.items[0].comment.body, max)}`;
}

/** "outdated · was line 20" and friends; null for a thread on its line. */
export function placementLabel(thread: DisplayThread): string | null {
  const t = thread.remote;
  if (!t) return null;
  if (thread.placement === "outdated") {
    const was = t.originalLine ?? t.line;
    return was !== null ? `outdated · was line ${was}` : "outdated";
  }
  if (thread.placement === "off-diff") return `line ${t.line} · not in this diff`;
  if (thread.placement === "file") return "whole file";
  return null;
}

/* ------------------------------------------------------------ the drawer */

export interface AuthorGroup {
  /** "people", or a bot key */
  key: string;
  label: string;
  bot: boolean;
  /** unresolved first, then file/line order */
  threads: RemoteThread[];
}

/**
 * GitHub threads by who started them: one group for people (the reader
 * included), then one per AI reviewer, by name.
 */
export function groupThreadsByAuthor(threads: RemoteThread[]): AuthorGroup[] {
  const people: AuthorGroup = { key: "people", label: "People", bot: false, threads: [] };
  const bots = new Map<string, AuthorGroup>();
  for (const t of threads) {
    const root = t.comments[0];
    if (!root) continue;
    const a = authorOf({ kind: "remote", comment: root });
    if (a.kind === "bot" && a.botKey) {
      let g = bots.get(a.botKey);
      if (!g) bots.set(a.botKey, (g = { key: a.botKey, label: a.name, bot: true, threads: [] }));
      g.threads.push(t);
    } else people.threads.push(t);
  }
  const order = (a: RemoteThread, b: RemoteThread) =>
    Number(a.isResolved) - Number(b.isResolved) ||
    a.path.localeCompare(b.path) ||
    (a.line ?? a.originalLine ?? -1) - (b.line ?? b.originalLine ?? -1);
  const groups = [people, ...[...bots.values()].sort((a, b) => a.label.localeCompare(b.label))];
  for (const g of groups) g.threads.sort(order);
  return groups.filter((g) => g.threads.length);
}

/**
 * The threads worth a row in the drawer's "On GitHub" group: all of them,
 * except one Purview started that nobody answered — it already has its row
 * among the reader's pushed or submitted comments.
 */
export function drawerThreads(threads: RemoteThread[]): RemoteThread[] {
  return threads.filter((t) => !(t.comments[0]?.localId && t.comments.every((c) => c.isMine)));
}

/**
 * The AI reviewers present on the PR, for the per-bot filter: those with
 * threads, plus those that only posted reviews or conversation comments
 * (`posts`, one author per post). `count` is threads + posts.
 */
export function knownBots(
  threads: RemoteThread[],
  posts: readonly RemoteAuthor[] = [],
): { key: string; name: string; count: number }[] {
  const out = groupThreadsByAuthor(threads)
    .filter((g) => g.bot)
    .map((g) => ({ key: g.key, name: g.label, count: g.threads.length }));
  for (const a of posts) {
    if (!a.bot) continue;
    const key = botKey(a.login);
    const known = out.find((b) => b.key === key);
    if (known) known.count++;
    else out.push({ key, name: a.botName ?? a.login.replace(/\[bot\]$/i, ""), count: 1 });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** "coderabbitai, @my-review-bot" → ["coderabbitai", "my-review-bot"] (the settings field). */
export function parseLoginList(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    const login = raw.trim().replace(/^@/, "");
    if (login && !out.some((l) => l.toLowerCase() === login.toLowerCase())) out.push(login);
  }
  return out;
}
