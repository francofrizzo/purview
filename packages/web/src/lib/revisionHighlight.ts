import type { Hunk, RevisionLineChanges } from "../api/types";
import { extractHunkBody } from "./diffModel";

/**
 * "Highlight what revisions N, M… changed": the changelog rows the reader
 * picked, turned into per-hunk row positions the diff pane marks, in one
 * color whatever the number of revisions. The server sends positions, not
 * text: indexes into each current hunk's body lines (`hunk.lines`, the
 * `buildRows` index space; see core's line-changes.ts and `hunkBodyLines` in
 * diffModel.ts), carried blame-style from each revision through every later
 * one. A position is exact, so a repeated line (`}`, a blank, `return err`)
 * marks only where that revision put it.
 */

/** A deletion run, where it sits now, and which highlighted revisions made it. */
export interface RemovedRun {
  /** row index of the line after the run (rows.length = past the end) */
  line: number;
  count: number;
  /** ascending; one revision unless several deleted lines at the same spot */
  revisions: readonly number[];
}

export interface HunkHighlight {
  /** the highlighted revisions that changed this hunk, ascending */
  revisions: readonly number[];
  /** unified row indexes those revisions introduced */
  lines: ReadonlySet<number>;
  lineCount: number;
  /** lines they deleted outright (an edit's old side is not counted) */
  removedCount: number;
  /** where those deletions sit now */
  removedAt: readonly RemovedRun[];
  /**
   * their lines that later revisions rewrote or removed, leaving out what
   * another highlighted revision did (that is marked as its own change)
   */
  rewrittenSince: number;
  /** nothing after the latest of `revisions` touched the hunk */
  exactAtCurrent: boolean;
  uncertain: boolean;
}

export interface RevisionHighlight {
  /** the highlighted revisions, ascending */
  revisions: readonly number[];
  /** keyed by the current revision's hunk id */
  byHunk: ReadonlyMap<string, HunkHighlight>;
  /** hunks of these revisions' changes that the scope held and that are gone now */
  goneCount: number;
}

/**
 * The highlight for one scope (a unit's hunk ids) and one or more revisions.
 * Without `hunkIds`, every hunk the revisions changed. Gone hunks count
 * toward the scope when the server attributed them to `unitId` (or, with no
 * unit, all of them).
 *
 * Several revisions merge into one highlight:
 * - marked lines are the union (a row two revisions both claim is one row);
 * - deletions are keyed by (revision, origin hunk, anchor): the same one seen
 *   twice (a hunk split and merged back) counts once, while different
 *   revisions' or origins' deletions at one anchor add up, since they deleted
 *   different lines; `removedCount` sums the same way, per (revision, origin);
 * - "since rewritten" leaves out rewrites made by another highlighted
 *   revision, so each line is tallied once: as the later revision's mark, or
 *   as its rewrite. An older server that sends no per-revision breakdown
 *   (`rewrittenBy`) gets its plain count;
 * - `exactAtCurrent` is the latest revision's own: "changed again after rN"
 *   is about what came after the last highlighted change;
 * - gone hunks count once however many revisions lead to them.
 * One revision's entries go through the same path, so two origins merged into
 * one current hunk no longer overwrite each other.
 */
export function buildHighlight(
  data: RevisionLineChanges | readonly RevisionLineChanges[],
  scope?: { hunkIds: readonly string[]; unitId?: string },
): RevisionHighlight {
  const all: RevisionLineChanges[] = ("hunks" in data ? [data] : [...data]).sort(
    (a, b) => a.revision - b.revision,
  );
  const selected = new Set(all.map((d) => d.revision));
  const allowed = scope ? new Set(scope.hunkIds) : null;

  interface Acc {
    revisions: Set<number>;
    lines: Set<number>;
    origins: Set<string>;
    anchors: Set<string>;
    removed: Map<number, { count: number; revisions: Set<number> }>;
    removedCount: number;
    rewrittenSince: number;
    latest: number;
    exactAtCurrent: boolean;
    uncertain: boolean;
  }
  const acc = new Map<string, Acc>();
  for (const d of all) {
    for (const h of d.hunks) {
      if (allowed && !allowed.has(h.currentHunkId)) continue;
      let a = acc.get(h.currentHunkId);
      if (!a) {
        a = {
          revisions: new Set(),
          lines: new Set(),
          origins: new Set(),
          anchors: new Set(),
          removed: new Map(),
          removedCount: 0,
          rewrittenSince: 0,
          latest: d.revision,
          exactAtCurrent: true,
          uncertain: false,
        };
        acc.set(h.currentHunkId, a);
      }
      a.revisions.add(d.revision);
      for (const l of h.lines) a.lines.add(l);
      const origin = `${d.revision}:${h.originHunkId}`;
      if (!a.origins.has(origin)) {
        a.origins.add(origin);
        a.removedCount += h.removedCount;
        a.rewrittenSince += h.rewrittenBy
          ? h.rewrittenBy.reduce((n, r) => (selected.has(r.revision) ? n : n + r.count), 0)
          : h.rewrittenSince;
      }
      for (const r of h.removedAt) {
        const key = `${origin}@${r.line}`;
        if (a.anchors.has(key)) continue;
        a.anchors.add(key);
        const run = a.removed.get(r.line) ?? { count: 0, revisions: new Set<number>() };
        run.count += r.count;
        run.revisions.add(d.revision);
        a.removed.set(r.line, run);
      }
      // Ascending order: a later revision resets, the same one narrows.
      if (d.revision > a.latest) a.exactAtCurrent = h.exactAtCurrent;
      else a.exactAtCurrent &&= h.exactAtCurrent;
      a.latest = d.revision;
      a.uncertain ||= Boolean(h.uncertain);
    }
  }

  const byHunk = new Map<string, HunkHighlight>();
  for (const [id, a] of acc) {
    byHunk.set(id, {
      revisions: ascending(a.revisions),
      lines: a.lines,
      lineCount: a.lines.size,
      removedCount: a.removedCount,
      removedAt: [...a.removed]
        .sort(([x], [y]) => x - y)
        .map(([line, r]) => ({ line, count: r.count, revisions: ascending(r.revisions) })),
      rewrittenSince: a.rewrittenSince,
      exactAtCurrent: a.exactAtCurrent,
      uncertain: a.uncertain,
    });
  }

  const gone = new Set<string>();
  for (const d of all) {
    for (const g of d.gone) {
      if (scope && (!scope.unitId || g.unitId !== scope.unitId)) continue;
      gone.add(`${g.goneAtRevision}:${g.lastHunkId}`);
    }
  }
  return { revisions: ascending(selected), byHunk, goneCount: gone.size };
}

function ascending(revisions: Iterable<number>): number[] {
  return [...revisions].sort((a, b) => a - b);
}

/** "r3" / "r3, r5" (hunk chips, tooltips) or, with " + ", "r3 + r5" (summary, header chip). */
export function revisionsLabel(revisions: readonly number[], separator = ", "): string {
  return revisions.map((r) => `r${r}`).join(separator);
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

/**
 * A deletion marker on one row: lines removed just above it, or (last row
 * only) just below, and the revisions that removed them (for the tooltip).
 */
export interface RemovalMark {
  above?: number;
  below?: number;
  aboveIn?: readonly number[];
  belowIn?: readonly number[];
}

function mergeRevisions(a: readonly number[] | undefined, b: readonly number[] | undefined): number[] | undefined {
  if (!a?.length) return b?.length ? [...b] : undefined;
  if (!b?.length) return [...a];
  return ascending(new Set([...a, ...b]));
}

/**
 * Where to draw "K lines removed" markers: on the top edge of the row that
 * now follows each deleted run, or on the last row's bottom edge for a run
 * that ended the hunk.
 */
export function removalMarks(
  rowCount: number,
  removedAt: readonly { line: number; count: number; revisions?: readonly number[] }[],
): Map<number, RemovalMark> {
  const out = new Map<number, RemovalMark>();
  if (rowCount === 0) return out;
  for (const { line, count, revisions } of removedAt) {
    if (!Number.isInteger(line) || line < 0 || line > rowCount || count <= 0) continue;
    const atEnd = line === rowCount;
    const at = atEnd ? rowCount - 1 : line;
    const mark = out.get(at) ?? {};
    if (atEnd) {
      mark.below = (mark.below ?? 0) + count;
      const into = mergeRevisions(mark.belowIn, revisions);
      if (into) mark.belowIn = into;
    } else {
      mark.above = (mark.above ?? 0) + count;
      const into = mergeRevisions(mark.aboveIn, revisions);
      if (into) mark.aboveIn = into;
    }
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
      if (i !== undefined) {
        const prev = out.get(i);
        const aboveIn = mergeRevisions(prev?.aboveIn, m.aboveIn);
        out.set(i, { ...prev, above: (prev?.above ?? 0) + m.above, ...(aboveIn ? { aboveIn } : {}) });
      }
    }
    if (m.below) {
      const i = splitRows.length - 1;
      const prev = out.get(i);
      const belowIn = mergeRevisions(prev?.belowIn, m.belowIn);
      out.set(i, { ...prev, below: (prev?.below ?? 0) + m.below, ...(belowIn ? { belowIn } : {}) });
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

/**
 * The deletion marker's tooltip: which revisions removed the lines, falling
 * back to the whole highlight's when the mark doesn't say.
 */
export function removalLabel(revisions: readonly number[], count: number): string {
  return `${plural(count, "line")} removed in ${revisionsLabel(revisions)}`;
}

/** The hunk header's label and tooltip. One revision keeps its own wording. */
export function hunkChangedLabel(h: HunkHighlight): { text: string; title: string } {
  const removed = h.removedCount > 0 ? ` · ${plural(h.removedCount, "line")} removed` : "";
  const rewritten = h.rewrittenSince > 0 ? ` · ${h.rewrittenSince} since rewritten` : "";
  const text = `changed in ${revisionsLabel(h.revisions)}${removed}${rewritten}`;
  const n = h.rewrittenSince;
  let title: string;
  if (h.revisions.length === 1) {
    const r = `r${h.revisions[0]}`;
    if (h.exactAtCurrent) {
      title = `Lines this hunk gained in ${r}`;
    } else if (h.uncertain) {
      title = `Changed again after ${r}, across a revision only partly on record; the marks assume ${r}'s lines stayed put there.`;
    } else {
      const since =
        n === 0
          ? `None of ${r}'s lines were rewritten by later revisions.`
          : `${n} of ${r}'s lines ${n === 1 ? "was" : "were"} rewritten by later revisions.`;
      title = `Changed again after ${r}. The marks are exact: they follow ${r}'s own lines. ${since}`;
    }
    return { text, title };
  }
  const list = listing(h.revisions);
  const latest = `r${h.revisions[h.revisions.length - 1]}`;
  const since =
    n === 0
      ? "None of their lines were rewritten by revisions outside the highlight."
      : `${n} of their lines ${n === 1 ? "was" : "were"} rewritten by revisions outside the highlight.`;
  if (h.uncertain) {
    title = `Changed in ${list}, across a revision only partly on record; the marks assume their lines stayed put there.`;
  } else if (h.exactAtCurrent) {
    title = `Lines this hunk gained in ${list}.${n > 0 ? ` ${since}` : ""}`;
  } else {
    title = `Changed again after ${latest}. The marks are exact: they follow each revision's own lines. ${since}`;
  }
  return { text, title };
}

/** "r3 and r5", "r2, r3 and r5". */
function listing(revisions: readonly number[]): string {
  const rs = revisions.map((r) => `r${r}`);
  return rs.length < 2 ? rs.join("") : `${rs.slice(0, -1).join(", ")} and ${rs[rs.length - 1]}`;
}

/**
 * The line under the changelog: what is being loaded, what failed (naming the
 * revision), or what is marked and what is gone. `highlight` is null until
 * every selected revision has loaded.
 */
export function highlightSummaryText(
  revisions: readonly number[],
  highlight: RevisionHighlight | null,
  failed: { revision: number; error: Error } | null,
): string {
  if (failed) return `Couldn't load the changes from r${failed.revision}: ${failed.error.message}`;
  const which = revisionsLabel(revisions, " + ");
  if (!highlight) return `Loading the changes from ${which}…`;
  const { lines, hunks } = highlightTally(highlight);
  const parts = [`Showing changes from ${which}`];
  parts.push(
    hunks === 0
      ? "none in this unit's current hunks"
      : `${plural(lines, "line")} in ${plural(hunks, "hunk")}`,
  );
  if (highlight.goneCount > 0) parts.push(`${plural(highlight.goneCount, "hunk")} since removed`);
  return parts.join(" · ");
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
