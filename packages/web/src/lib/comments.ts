/**
 * Grouping comments the way the diff surface needs to read them.
 *
 * The diff renders line by line, so it asks "what hangs off *this* anchor?"
 * thousands of times per scroll. Bucketing once into a map keyed by anchor is
 * what keeps that a hash lookup instead of a scan. Pure functions only.
 */

import type { FilesJson } from "../api/types";
import {
  isFileComment,
  type CommentStatus,
  type CommentSubject,
  type CommentActor,
  type DeletedComment,
  type DraftComment,
} from "../api/types";

/**
 * Anchor key for a line comment: the tuple GitHub itself anchors on. A
 * multi-line comment anchors on its LAST line (that is where its marker goes).
 */
export function lineAnchor(file: string, line: number, side: "LEFT" | "RIGHT"): string {
  return `${file}:${line}:${side}`;
}

/** What a comment's lines look like: `startLine..line` for a range, else just the line. */
export interface LineSpan {
  line?: number | null;
  startLine?: number | null;
}

/** `12–18` for a range, `18` for one line (an en dash, like GitHub's own label). */
export function lineLabel(c: LineSpan): string {
  if (c.line === null || c.line === undefined) return "";
  const start = c.startLine ?? undefined;
  return start !== undefined && start !== c.line ? `${start}–${c.line}` : `${c.line}`;
}

/** The first line a comment covers — `line` itself unless it is a range. */
export function firstLine(c: LineSpan): number | undefined {
  if (c.line === null || c.line === undefined) return undefined;
  return c.startLine ?? c.line;
}

/** Is this a multi-line comment (a range of two or more lines)? */
export function isRange(c: LineSpan): boolean {
  return c.startLine !== null && c.startLine !== undefined && c.line !== null && c.line !== undefined && c.startLine < c.line;
}

export interface CommentGroups {
  /** line comments, keyed by {@link lineAnchor} */
  byLine: Map<string, DraftComment[]>;
  /** file-level comments, keyed by path */
  byFile: Map<string, DraftComment[]>;
}

/**
 * One pass over the comment list. Comments keep their incoming order inside a
 * bucket, which is the order the server returns them in (creation order).
 */
export function groupComments(comments: DraftComment[]): CommentGroups {
  const byLine = new Map<string, DraftComment[]>();
  const byFile = new Map<string, DraftComment[]>();
  for (const c of comments) {
    if (isFileComment(c)) {
      push(byFile, c.file, c);
      continue;
    }
    // Defensive: a line comment without a side is anchored the way GitHub
    // anchors context lines.
    push(byLine, lineAnchor(c.file, c.line as number, c.side ?? "RIGHT"), c);
  }
  return { byLine, byFile };
}

function push<K>(map: Map<K, DraftComment[]>, key: K, value: DraftComment) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** The subset of a comment the shared ordering needs — nothing about status. */
export interface OrderableComment {
  file: string;
  /** null for a file-level comment */
  line: number | null;
  side?: "LEFT" | "RIGHT" | null;
  subjectType?: CommentSubject;
}

/**
 * The one ordering every surface that lists comments across files should use:
 * file path, then — within a file — the file-level comment ahead of every
 * line comment, then by line, then LEFT before RIGHT. `Array.prototype.sort`
 * is stable, so comments that tie on all of the above keep their incoming
 * (creation) order.
 *
 * Shared between the drafts drawer and {@link ../lib/agentExport | agentExport}
 * so the two can't drift apart again.
 */
export function compareCommentOrder(a: OrderableComment, b: OrderableComment): number {
  const lineOf = (c: OrderableComment) => (isFileComment(c) ? -1 : (c.line as number));
  const sideOf = (c: OrderableComment) => c.side ?? "";
  return (
    a.file.localeCompare(b.file) || lineOf(a) - lineOf(b) || sideOf(a).localeCompare(sideOf(b))
  );
}

/** How far along the review lifecycle a status is; higher wins a rollup. */
const RANK: Record<CommentStatus, number> = { draft: 0, pushed: 1, submitted: 2 };

/**
 * The status a gutter bubble should be painted with: the most advanced one
 * present, so a line holding a draft *and* a submitted comment reads as
 * "something here is already public" rather than "just a scratch note".
 */
export function mostAdvancedStatus(comments: { status?: CommentStatus }[]): CommentStatus {
  let best: CommentStatus = "draft";
  for (const c of comments) {
    const status = c.status ?? "draft";
    if (RANK[status] > RANK[best]) best = status;
  }
  return best;
}

/**
 * The status a line's marker shows: the one that still needs the reader. Any
 * draft makes it a draft (unsent work), else any pushed comment (pending on
 * GitHub), else submitted. Painting the most advanced one hid a line's unsent
 * drafts behind an older, already-public comment.
 */
export function attentionStatus(comments: { status?: CommentStatus }[]): CommentStatus {
  let worst: CommentStatus = "submitted";
  for (const c of comments) {
    const status = c.status ?? "draft";
    if (RANK[status] < RANK[worst]) worst = status;
  }
  return comments.length ? worst : "draft";
}

/** Token pair for the bubble, matching the chips used everywhere else. */
export function statusColors(status: CommentStatus): { fg: string; bg: string } {
  if (status === "pushed") return { fg: "var(--accent)", bg: "var(--accent-soft)" };
  if (status === "submitted") return { fg: "var(--ok)", bg: "var(--bg-inset)" };
  return { fg: "var(--fg-muted)", bg: "var(--bg-inset)" };
}

/**
 * Is a draft line comment's anchor still inside the current diff? Mirrors
 * the server's `findAnchoringHunk` (packages/server/src/comments.ts) —
 * RIGHT against `newStart`/`newLines`, LEFT against `oldStart`/`oldLines` —
 * so the same "this comment fell outside the diff" verdict shows up here
 * without a round trip. A file-level comment has no line, so it's always
 * anchored (the file itself is the anchor).
 */
export function isCommentAnchored(files: FilesJson, comment: DraftComment): boolean {
  if (isFileComment(comment)) return true;
  const side = comment.side ?? "RIGHT";
  const line = comment.line as number;
  return isRange(comment)
    ? isRangeInDiff(files, comment.file, side, comment.startLine as number, line)
    : isLineInDiff(files, comment.file, line, side);
}

/** Is this line, on this side, inside one of the file's hunks? */
export function isLineInDiff(files: FilesJson, path: string, line: number, side: "LEFT" | "RIGHT"): boolean {
  return isRangeInDiff(files, path, side, line, line);
}

/**
 * Is the whole `start..end` range (on one side) inside ONE of the file's
 * hunks? GitHub refuses a multi-line comment that straddles two hunks, so the
 * compose affordance and the "outside the diff" verdict both ask this.
 */
export function isRangeInDiff(
  files: FilesJson,
  path: string,
  side: "LEFT" | "RIGHT",
  start: number,
  end: number,
): boolean {
  const file = files.files.find((f) => f.path === path);
  if (!file) return false;
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  return file.hunks.some((h) => {
    const [from, count] = side === "RIGHT" ? [h.newStart, h.newLines] : [h.oldStart, h.oldLines];
    return count > 0 && lo >= from && hi < from + count;
  });
}

/** "3 comments (1 submitted)" — the bubble's tooltip. */
export function bubbleTitle(comments: DraftComment[]): string {
  const n = comments.length;
  const noun = n === 1 ? "comment" : "comments";
  const counts = (["draft", "pushed", "submitted"] as const)
    .map((st) => [st, comments.filter((c) => (c.status ?? "draft") === st).length] as const)
    .filter(([, k]) => k > 0);
  const mix = counts.length === 1 && n > 1 ? `all ${counts[0][0]}` : counts.map(([st, k]) => (n === 1 ? st : `${k} ${st}`)).join(", ");
  return `${n} ${noun} · ${mix} — click to ${n === 1 ? "read it" : "read them"}`;
}

/* ------------------------------------------------ comments the chat wrote */

/** The review chat's agent, whichever harness it ran on. */
export function isAgentActor(actor: CommentActor | undefined): actor is { agent: string } {
  return typeof actor === "object" && actor !== null;
}

/** Created by the review chat (`reviewer-state comment add` under PURVIEW_ACTOR=chat). */
export function isByAgent(c: Pick<DraftComment, "author">): boolean {
  return isAgentActor(c.author);
}

/**
 * The chat's latest edit is still in effect and can be taken back: a draft
 * whose last edit was the chat agent's, with an earlier body on record. Pushed and
 * submitted comments are never undoable here (the server refuses it too).
 */
export function canUndoAgentEdit(
  c: Pick<DraftComment, "status" | "lastEditedBy" | "history">,
): boolean {
  return (c.status ?? "draft") === "draft" && isAgentActor(c.lastEditedBy) && (c.history?.length ?? 0) > 0;
}

/** Drafts the chat deleted that are still restorable, newest first, minus the ones dismissed. */
export function agentDeletedDrafts(
  deleted: DeletedComment[],
  dismissed: ReadonlySet<string> = new Set(),
): DeletedComment[] {
  return deleted
    .filter((d) => isAgentActor(d.deletedBy) && !dismissed.has(d.id))
    .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

/**
 * A chat tool call that changes comments: a shell command running the
 * reviewer-state CLI's `comment add|edit|delete`. The chat panel refreshes
 * the comments query once such a call has finished.
 */
export function isCommentWriteTool(tool: { name?: string; kind?: string; detail?: string }): boolean {
  return tool.kind === "command" && /\bcomment\s+(add|edit|delete)\b/.test(tool.detail ?? "");
}
