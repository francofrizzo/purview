/**
 * Grouping comments the way the diff surface needs to read them.
 *
 * The diff renders line by line, so it asks "what hangs off *this* anchor?"
 * thousands of times per scroll. Bucketing once into a map keyed by anchor is
 * what keeps that a hash lookup instead of a scan. Pure functions only.
 */

import { isFileComment, type CommentStatus, type DraftComment } from "../api/types";

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

/** "3 comments (1 submitted)" — the bubble's tooltip. */
export function bubbleTitle(comments: DraftComment[]): string {
  const n = comments.length;
  const noun = n === 1 ? "comment" : "comments";
  return `${n} ${noun} · ${mostAdvancedStatus(comments)} — click to ${n === 1 ? "read it" : "read them"}`;
}
