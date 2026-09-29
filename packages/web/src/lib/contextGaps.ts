/**
 * "Expand context" around hunks: the unchanged lines a diff leaves out, as
 * gaps between a file's hunks (and before the first, after the last).
 *
 * Every line in a gap is unchanged, so one new-side range plus a constant
 * shift (old = new - shift) describes it; only the file at the PR head is
 * ever needed to show one. Pure: DiffPane owns the state and the fetch.
 */

import type { Hunk } from "../api/types";

export type HunkRange = Pick<Hunk, "id" | "oldStart" | "oldLines" | "newStart" | "newLines">;

export interface Gap {
  /** `${path}:${prevHunkId ?? "^"}` — stable across renders */
  key: string;
  path: string;
  prevHunkId: string | null;
  nextHunkId: string | null;
  /** first hidden new-side line (1-based) */
  from: number;
  /** last hidden new-side line; null past the last hunk, until the file's length is known */
  to: number | null;
  /** old-side number = new-side number - shift, for every line in the gap */
  shift: number;
}

/** How much of a gap the reader opened, from its top and from its bottom. */
export interface GapReveal {
  top: number;
  bottom: number;
}

// An empty side (`+4,0`) names the line *before* the change, so its range
// starts one later: first line of the side, and one past its last.
const firstOf = (start: number, count: number) => (count === 0 ? start + 1 : start);
const endOf = (start: number, count: number) => (count === 0 ? start + 1 : start + count);

/** The gaps of one file, given all its hunks (in any order). */
export function fileGaps(path: string, hunks: HunkRange[]): Gap[] {
  const sorted = [...hunks].sort((a, b) => a.newStart - b.newStart);
  const gaps: Gap[] = [];
  const push = (g: Omit<Gap, "key" | "path">) => {
    if (g.to !== null && g.to < g.from) return;
    gaps.push({ key: `${path}:${g.prevHunkId ?? "^"}`, path, ...g });
  };
  sorted.forEach((h, i) => {
    const prev = sorted[i - 1];
    if (!prev) {
      push({
        prevHunkId: null,
        nextHunkId: h.id,
        from: 1,
        to: firstOf(h.newStart, h.newLines) - 1,
        shift: firstOf(h.newStart, h.newLines) - firstOf(h.oldStart, h.oldLines),
      });
    }
    const next = sorted[i + 1];
    const from = endOf(h.newStart, h.newLines);
    push({
      prevHunkId: h.id,
      nextHunkId: next?.id ?? null,
      from,
      to: next ? firstOf(next.newStart, next.newLines) - 1 : null,
      shift: from - endOf(h.oldStart, h.oldLines),
    });
  });
  return gaps;
}

export interface RevealedGap {
  /** lines shown under the hunk above, as [first, last] new-side numbers */
  top: [number, number] | null;
  /** lines shown over the hunk below */
  bottom: [number, number] | null;
  /** still hidden between them; null while the file's length is unknown */
  hidden: number | null;
}

/**
 * What a gap shows given how far it was opened. `fileLength` resolves the
 * open end of the last gap; without it only a bounded gap can be laid out.
 */
export function revealGap(gap: Gap, reveal: GapReveal, fileLength: number | null): RevealedGap {
  const to = gap.to ?? fileLength;
  if (to === null) return { top: null, bottom: null, hidden: null };
  const size = Math.max(0, to - gap.from + 1);
  const t = Math.min(Math.max(reveal.top, 0), size);
  const b = Math.min(Math.max(reveal.bottom, 0), size - t);
  return {
    top: t > 0 ? [gap.from, gap.from + t - 1] : null,
    bottom: b > 0 ? [to - b + 1, to] : null,
    hidden: size - t - b,
  };
}

/** Lines one "expand" click reveals, as on GitHub. */
export const EXPAND_STEP = 20;
