import type { Hunk, RevisionLineChanges } from "../api/types";
import { extractHunkBody } from "./diffModel";

/**
 * "Highlight what revision N changed": the changelog row the reader clicked,
 * turned into per-hunk line sets the diff pane can match rows against. The
 * server sends raw body lines (prefix + content); the pane marks a rendered
 * row when its raw line is one of them, consuming matches so a line
 * introduced once marks once even when the hunk repeats it.
 */

export interface HunkHighlight {
  /** raw line -> how many times the revision introduced it */
  introduced: ReadonlyMap<string, number>;
  introducedCount: number;
  droppedCount: number;
  exactAtCurrent: boolean;
}

export interface RevisionHighlight {
  revision: number;
  /** keyed by the current revision's hunk id */
  byHunk: ReadonlyMap<string, HunkHighlight>;
  /** hunks of this revision's changes that the scope held and that are gone now */
  goneCount: number;
}

export function toMultiset(lines: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) out.set(l, (out.get(l) ?? 0) + 1);
  return out;
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
      introduced: toMultiset(h.introduced),
      introducedCount: h.introduced.length,
      droppedCount: h.droppedCount,
      exactAtCurrent: h.exactAtCurrent,
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
 * space as `buildRows`) the revision introduced. First occurrences win: a
 * line introduced twice marks the first two rows carrying it, no more.
 */
export function markedRowIndexes(
  rawLines: readonly string[],
  introduced: ReadonlyMap<string, number>,
): Set<number> {
  const out = new Set<number>();
  if (introduced.size === 0) return out;
  const left = new Map(introduced);
  rawLines.forEach((line, i) => {
    const n = left.get(line);
    if (!n) return;
    out.add(i);
    left.set(line, n - 1);
  });
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
    out.set(hunk.id, markedRowIndexes(rawHunkLines(hunk, diffText), h.introduced));
  }
  return out;
}

/** The hunk header's label and tooltip. */
export function hunkChangedLabel(revision: number, h: HunkHighlight): { text: string; title: string } {
  const dropped = h.droppedCount > 0 ? ` · ${plural(h.droppedCount, "line")} removed` : "";
  const title = h.exactAtCurrent
    ? `Lines this hunk gained in r${revision}`
    : `Changed again after r${revision}; lines matched by content.`;
  return { text: `changed in r${revision}${dropped}`, title };
}

/** "N lines in M hunks" for the unit header. */
export function highlightTally(h: RevisionHighlight): { lines: number; hunks: number } {
  let lines = 0;
  for (const v of h.byHunk.values()) lines += v.introducedCount;
  return { lines, hunks: h.byHunk.size };
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
