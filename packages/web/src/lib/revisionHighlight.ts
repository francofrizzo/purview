import type { Hunk, RevisionLineChanges } from "../api/types";
import { extractHunkBody } from "./diffModel";

/**
 * "Highlight what revision N changed": the changelog row the reader clicked,
 * turned into per-hunk row positions the diff pane marks. The server sends
 * positions, not text: indexes into each current hunk's body lines
 * (`hunk.lines`, the `buildRows` index space; see core's line-changes.ts and
 * `hunkBodyLines` in diffModel.ts), carried blame-style from revision N
 * through every later revision. A position is exact, so a repeated line
 * (`}`, a blank, `return err`) marks only where N put it.
 */

export interface HunkHighlight {
  /** unified row indexes the revision introduced */
  lines: ReadonlySet<number>;
  lineCount: number;
  /** lines the revision deleted outright (an edit's old side is not counted) */
  removedCount: number;
  /** where those deletions sit now (row index of the line after; rows.length = past the end) */
  removedAt: readonly { line: number; count: number }[];
  /** the revision's lines later revisions rewrote or removed */
  rewrittenSince: number;
  exactAtCurrent: boolean;
  uncertain: boolean;
}

export interface RevisionHighlight {
  revision: number;
  /** keyed by the current revision's hunk id */
  byHunk: ReadonlyMap<string, HunkHighlight>;
  /** hunks of this revision's changes that the scope held and that are gone now */
  goneCount: number;
}

/**
 * The highlight for one scope (a unit's hunk ids). Without `hunkIds`, every
 * hunk the revision changed. Gone hunks count toward the scope when the
 * server attributed them to `unitId` (or, with no unit, all of them).
 */
export function buildHighlight(
  data: RevisionLineChanges,
  scope?: { hunkIds: readonly string[]; unitId?: string },
): RevisionHighlight {
  const allowed = scope ? new Set(scope.hunkIds) : null;
  const byHunk = new Map<string, HunkHighlight>();
  for (const h of data.hunks) {
    if (allowed && !allowed.has(h.currentHunkId)) continue;
    byHunk.set(h.currentHunkId, {
      lines: new Set(h.lines),
      lineCount: h.lines.length,
      removedCount: h.removedCount,
      removedAt: h.removedAt,
      rewrittenSince: h.rewrittenSince,
      exactAtCurrent: h.exactAtCurrent,
      uncertain: Boolean(h.uncertain),
    });
  }
  const goneCount = scope?.unitId
    ? data.gone.filter((g) => g.unitId === scope.unitId).length
    : scope
      ? 0
      : data.goneCount;
  return { revision: data.revision, byHunk, goneCount };
}

/**
 * Which of a hunk's rows (indexes into its raw body lines, the same index
 * space as `buildRows`) the revision introduced: the server's positions,
 * minus any outside the rows actually rendered.
 */
export function markedRowIndexes(rowCount: number, lines: Iterable<number>): Set<number> {
  const out = new Set<number>();
  for (const i of lines) if (Number.isInteger(i) && i >= 0 && i < rowCount) out.add(i);
  return out;
}

/** A deletion marker on one row: lines removed just above it, or (last row only) just below. */
export interface RemovalMark {
  above?: number;
  below?: number;
}

/**
 * Where to draw "K lines removed" markers: on the top edge of the row that
 * now follows each deleted run, or on the last row's bottom edge for a run
 * that ended the hunk.
 */
export function removalMarks(
  rowCount: number,
  removedAt: readonly { line: number; count: number }[],
): Map<number, RemovalMark> {
  const out = new Map<number, RemovalMark>();
  if (rowCount === 0) return out;
  for (const { line, count } of removedAt) {
    if (!Number.isInteger(line) || line < 0 || line > rowCount || count <= 0) continue;
    const atEnd = line === rowCount;
    const at = atEnd ? rowCount - 1 : line;
    const mark = out.get(at) ?? {};
    if (atEnd) mark.below = (mark.below ?? 0) + count;
    else mark.above = (mark.above ?? 0) + count;
    out.set(at, mark);
  }
  return out;
}

/**
 * The same markers in split view, keyed by split row: a marker sits on the
 * first split row holding its unified row (either half); a "below" marker on
 * the last split row. Split view draws them on the left (old) half.
 */
export function splitRemovalMarks(
  marks: ReadonlyMap<number, RemovalMark>,
  splitRows: readonly { left: { index: number } | null; right: { index: number } | null }[],
): Map<number, RemovalMark> {
  const out = new Map<number, RemovalMark>();
  if (marks.size === 0 || splitRows.length === 0) return out;
  const splitOf = new Map<number, number>();
  splitRows.forEach((r, i) => {
    for (const cell of [r.left, r.right]) if (cell && !splitOf.has(cell.index)) splitOf.set(cell.index, i);
  });
  for (const [u, m] of marks) {
    if (m.above) {
      const i = splitOf.get(u);
      if (i !== undefined) out.set(i, { ...out.get(i), above: (out.get(i)?.above ?? 0) + m.above });
    }
    if (m.below) {
      const i = splitRows.length - 1;
      out.set(i, { ...out.get(i), below: (out.get(i)?.below ?? 0) + m.below });
    }
  }
  return out;
}

/** A hunk's raw body lines, aligned with `buildRows` (same source, same order). */
export function rawHunkLines(hunk: Hunk, diffText: string): string[] {
  return hunk.lines?.length ? hunk.lines : extractHunkBody(diffText, hunk);
}

/** Every marked row, per hunk, for the hunks shown. Computed once per highlight. */
export function markedByHunk(
  hunks: readonly Hunk[],
  highlight: RevisionHighlight | null | undefined,
  diffText: string,
): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  if (!highlight) return out;
  for (const hunk of hunks) {
    const h = highlight.byHunk.get(hunk.id);
    if (!h) continue;
    out.set(hunk.id, markedRowIndexes(rawHunkLines(hunk, diffText).length, h.lines));
  }
  return out;
}

/** Every deletion marker, per hunk, for the hunks shown. */
export function removalMarksByHunk(
  hunks: readonly Hunk[],
  highlight: RevisionHighlight | null | undefined,
  diffText: string,
): Map<string, Map<number, RemovalMark>> {
  const out = new Map<string, Map<number, RemovalMark>>();
  if (!highlight) return out;
  for (const hunk of hunks) {
    const h = highlight.byHunk.get(hunk.id);
    if (!h || h.removedAt.length === 0) continue;
    const marks = removalMarks(rawHunkLines(hunk, diffText).length, h.removedAt);
    if (marks.size > 0) out.set(hunk.id, marks);
  }
  return out;
}

/** The deletion marker's tooltip. */
export function removalLabel(revision: number, count: number): string {
  return `${plural(count, "line")} removed in r${revision}`;
}

/** The hunk header's label and tooltip. */
export function hunkChangedLabel(revision: number, h: HunkHighlight): { text: string; title: string } {
  const removed = h.removedCount > 0 ? ` · ${plural(h.removedCount, "line")} removed` : "";
  const rewritten = h.rewrittenSince > 0 ? ` · ${h.rewrittenSince} since rewritten` : "";
  const r = `r${revision}`;
  let title: string;
  if (h.exactAtCurrent) {
    title = `Lines this hunk gained in ${r}`;
  } else if (h.uncertain) {
    title = `Changed again after ${r}, across a revision only partly on record; the marks assume ${r}'s lines stayed put there.`;
  } else {
    const n = h.rewrittenSince;
    const since =
      n === 0
        ? `None of ${r}'s lines were rewritten by later revisions.`
        : `${n} of ${r}'s lines ${n === 1 ? "was" : "were"} rewritten by later revisions.`;
    title = `Changed again after ${r}. The marks are exact: they follow ${r}'s own lines. ${since}`;
  }
  return { text: `changed in ${r}${removed}${rewritten}`, title };
}

/** "N lines in M hunks" for the unit header. */
export function highlightTally(h: RevisionHighlight): { lines: number; hunks: number } {
  let lines = 0;
  for (const v of h.byHunk.values()) lines += v.lineCount;
  return { lines, hunks: h.byHunk.size };
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
