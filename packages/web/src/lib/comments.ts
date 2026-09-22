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
  type DeletedComment,
  type DraftComment,
} from "../api/types";

/** Anchor key for a line comment: the tuple GitHub itself anchors on. */
export function lineAnchor(file: string, line: number, side: "LEFT" | "RIGHT"): string {
  return `${file}:${line}:${side}`;
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
  const line = comment.line as number;
  const side = comment.side ?? "RIGHT";
  const file = files.files.find((f) => f.path === comment.file);
  if (!file) return false;
  return file.hunks.some((h) =>
    side === "RIGHT"
      ? h.newLines > 0 && line >= h.newStart && line < h.newStart + h.newLines
      : h.oldLines > 0 && line >= h.oldStart && line < h.oldStart + h.oldLines,
  );
}

/** "3 comments (1 submitted)" — the bubble's tooltip. */
export function bubbleTitle(comments: DraftComment[]): string {
  const n = comments.length;
  const noun = n === 1 ? "comment" : "comments";
  return `${n} ${noun} · ${mostAdvancedStatus(comments)} — click to ${n === 1 ? "read it" : "read them"}`;
}

/* ------------------------------------------------ comments the chat wrote */

/** Created by the review chat (`reviewer-state comment add` under PURVIEW_ACTOR=chat). */
export function isByClaude(c: Pick<DraftComment, "author">): boolean {
  return c.author === "claude";
}

/**
 * The chat's latest edit is still in effect and can be taken back: a draft
 * whose last edit was Claude's, with an earlier body on record. Pushed and
 * submitted comments are never undoable here (the server refuses it too).
 */
export function canUndoClaudeEdit(
  c: Pick<DraftComment, "status" | "lastEditedBy" | "history">,
): boolean {
  return (c.status ?? "draft") === "draft" && c.lastEditedBy === "claude" && (c.history?.length ?? 0) > 0;
}

/** Drafts the chat deleted that are still restorable, newest first, minus the ones dismissed. */
export function claudeDeletedDrafts(
  deleted: DeletedComment[],
  dismissed: ReadonlySet<string> = new Set(),
): DeletedComment[] {
  return deleted
    .filter((d) => d.deletedBy === "claude" && !dismissed.has(d.id))
    .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

/**
 * A chat tool call that changes comments: a Bash run of the reviewer-state
 * CLI's `comment add|edit|delete`. The chat panel refreshes the comments
 * query once such a call has finished.
 */
export function isCommentWriteTool(tool: { name: string; detail?: string }): boolean {
  return tool.name === "Bash" && /\bcomment\s+(add|edit|delete)\b/.test(tool.detail ?? "");
}
