/**
 * Sticky file/hunk headers over the virtualized diff.
 *
 * The mechanism is the canonical TanStack Virtual one: a custom rangeExtractor
 * keeps the "current" header rows mounted even when their own slots are
 * scrolled out, and the render swaps those rows from translateY positioning to
 * `position: sticky`. Being the lowest indexes in the range they are also the
 * first in DOM order, so their in-flow position is the top of the scroll
 * container and the sticky constraint pins them to the viewport from there.
 *
 * This module is the pure part: which rows are the current headers for a given
 * visible start index. It knows nothing about react-virtual.
 */

export interface StickyHeaders {
  /** row index of the file header the viewport is inside, if any */
  file?: number;
  /** row index of the hunk header the viewport is inside, if any */
  hunk?: number;
}

/** Largest value in ascending `sorted` that is <= x (binary search). */
function lastAtOrBelow(sorted: number[], x: number): number | undefined {
  let lo = 0;
  let hi = sorted.length - 1;
  let out: number | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= x) {
      out = sorted[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return out;
}

/**
 * The headers governing the row at `startIndex`. Rows are laid out
 * `file, [filecomments,] hunk, lines…, hunk, lines…, file, …`, so the current
 * file is the last file header at or above the start, and the current hunk is
 * the last hunk header at or above it — unless that hunk belongs to the
 * *previous* file (a file header sits between them), in which case the
 * viewport is in the gap before the file's first hunk and only the file
 * header sticks.
 */
export function stickyHeadersFor(
  fileIdxs: number[],
  hunkIdxs: number[],
  startIndex: number,
): StickyHeaders {
  const file = lastAtOrBelow(fileIdxs, startIndex);
  let hunk = lastAtOrBelow(hunkIdxs, startIndex);
  if (hunk !== undefined && file !== undefined && hunk < file) hunk = undefined;
  return { file, hunk };
}

/** The extractor's contract: ascending, no duplicates. */
export function mergeStickyIntoRange(sticky: StickyHeaders, visible: number[]): number[] {
  const set = new Set(visible);
  if (sticky.file !== undefined) set.add(sticky.file);
  if (sticky.hunk !== undefined) set.add(sticky.hunk);
  return [...set].sort((a, b) => a - b);
}
