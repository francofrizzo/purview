import type { FileEntry, Hunk } from "../api/types";

/**
 * MIRRORED IMPLEMENTATION — packages/core/src/move-detection.ts is the same
 * algorithm over core's types (the server needs it to describe moves to the
 * analysis prompt), because this package deliberately does not depend on
 * core. The two copies share their behavioral contract through matching test
 * vectors; change one, change both, and keep the constants identical.
 *
 * Move detection (git `--color-moved` spirit): a contiguous run of removed
 * lines that reappears, in order, as added lines elsewhere in the same
 * revision is a code move — even when it's buried inside a hunk that also
 * has genuinely new changes around it. That "buried in a mixed hunk" case
 * is why this operates at line-RUN granularity rather than whole-hunk: a
 * whole-hunk Jaccard score is structurally blind to a function extraction
 * that shares a hunk with unrelated edits (the novel lines drag the score
 * under threshold), which is exactly the shape real refactors take.
 *
 * Line content mirrors core's hunk identity (packages/core/src/hunk-id.ts):
 * the same `addedLines`/`removedLines` arrays that seed `computeHunkId`
 * (each line has only its leading `+`/`-` marker stripped, otherwise
 * verbatim) — the API client surfaces them on `Hunk` already, so this reuses
 * them rather than re-deriving anything from the raw diff text.
 *
 * hunk-id.ts itself does *no* normalization beyond that marker strip — two
 * hunks that differ by so much as a trailing space get different ids, which
 * is exactly what a stable, content-derived identity needs. Move detection
 * wants the opposite: a moved block that picked up a reindent, or a blank
 * line, along the way should still read as the same block. So, on top of
 * those same raw lines, this file adds two things neither hunk-id.ts nor
 * migration.ts's `jaccard()` do: trimming each line, and requiring a line be
 * "significant" (see `isSignificant`) before it can seed or count toward a
 * run — otherwise a handful of `}` or `import (` lines lining up between two
 * unrelated hunks would read as a move. If core ever grows its own
 * normalization, this comment is the tripwire to notice the drift.
 */

export interface MoveCounterpart {
  path: string;
  hunkId: string;
  direction: "out" | "in";
}

export interface HunkMoves {
  /** indexes into the hunk's removedLines that are part of a moved-out run */
  movedOut: Set<number>;
  /** indexes into the hunk's addedLines that are part of a moved-in run */
  movedIn: Set<number>;
  /** counterpart hunks for the badge, deduped, order = first occurrence */
  counterparts: MoveCounterpart[];
}

/** A qualifying run needs at least this many *significant* lines (blank and
 *  punctuation-only filler swept into the run don't count). */
const MIN_SIGNIFICANT_LINES = 3;
/** A trimmed line at or above this length is significant on length alone. */
const MIN_SIGNIFICANT_LENGTH = 8;
/** ...or, short but with a real identifier/word in it (`if (x)` etc). Plain
 *  punctuation runs (`}`, `);`, `end`) never match this. */
const WORD_RUN = /[A-Za-z0-9_]{4,}/;

function normalize(line: string): string {
  return line.trim();
}

function isSignificant(normalized: string): boolean {
  if (normalized.length === 0) return false;
  return normalized.length >= MIN_SIGNIFICANT_LENGTH || WORD_RUN.test(normalized);
}

interface Entry {
  hunk: Hunk;
  path: string;
  added: string[];
  removed: string[];
}

interface AddedOccurrence {
  entry: Entry;
  idx: number;
}

interface Run {
  removedIdx: number[];
  addedIdx: number[];
}

/**
 * Grow a run forward from a matched starting pair. Consecutive lines must
 * match exactly (post-normalization) to extend the run, but a blank-
 * normalized line on *either* side is swept in for free — a moved block can
 * pick up or drop surrounding blank padding without that breaking the run.
 */
function extendRun(
  removed: string[],
  added: string[],
  rStart: number,
  aStart: number,
  removedTaken: (i: number) => boolean,
  addedTaken: (i: number) => boolean,
): Run {
  const removedIdx = [rStart];
  const addedIdx = [aStart];
  let r = rStart + 1;
  let a = aStart + 1;
  for (;;) {
    while (r < removed.length && !removedTaken(r) && normalize(removed[r]) === "") {
      removedIdx.push(r);
      r++;
    }
    while (a < added.length && !addedTaken(a) && normalize(added[a]) === "") {
      addedIdx.push(a);
      a++;
    }
    if (r >= removed.length || a >= added.length) break;
    if (removedTaken(r) || addedTaken(a)) break;
    const nr = normalize(removed[r]);
    const na = normalize(added[a]);
    if (nr === "" || na === "" || nr !== na) break;
    removedIdx.push(r);
    addedIdx.push(a);
    r++;
    a++;
  }
  return { removedIdx, addedIdx };
}

function countSignificant(lines: string[], idx: number[]): number {
  let n = 0;
  for (const i of idx) if (isSignificant(normalize(lines[i]))) n++;
  return n;
}

/**
 * Detect moved line-runs across every file of one revision.
 *
 * Single pass over every hunk's removed lines in document order. At each
 * unconsumed, significant removed line, every unconsumed added occurrence of
 * its normalized content is tried as a run start (`extendRun`); the longest
 * (by significant-line count) qualifying run — >= {@link MIN_SIGNIFICANT_LINES}
 * significant lines — wins and consumes both sides. An added occurrence
 * that never wins a run this way stays available for a later removed line,
 * which is what "first-come by document order" cashes out to here: whichever
 * removed run claims it first (in iteration order) gets it, ties broken by
 * run length.
 *
 * This is deliberately local/greedy, not a global optimum — same spirit as
 * migration.ts's fuzzy matching, cheap and good enough for a rendering hint.
 */
export function detectMoves(files: FileEntry[]): Map<string, HunkMoves> {
  const entries: Entry[] = [];
  for (const file of files) {
    for (const hunk of file.hunks) {
      entries.push({
        hunk,
        path: file.path,
        added: hunk.addedLines ?? [],
        removed: hunk.removedLines ?? [],
      });
    }
  }

  // Every added line occurrence, in document order, keyed by normalized
  // content. Blank lines are never indexed — they can only ever be swept
  // into a run already anchored by real content on both ends.
  const addedIndex = new Map<string, AddedOccurrence[]>();
  for (const entry of entries) {
    entry.added.forEach((line, idx) => {
      const norm = normalize(line);
      if (norm === "") return;
      const list = addedIndex.get(norm);
      if (list) list.push({ entry, idx });
      else addedIndex.set(norm, [{ entry, idx }]);
    });
  }

  const consumedRemoved = new Map<string, Set<number>>();
  const consumedAdded = new Map<string, Set<number>>();
  const isRemovedTaken = (hunkId: string, i: number) => consumedRemoved.get(hunkId)?.has(i) ?? false;
  const isAddedTaken = (hunkId: string, i: number) => consumedAdded.get(hunkId)?.has(i) ?? false;
  const takeRemoved = (hunkId: string, idx: number[]) => {
    let s = consumedRemoved.get(hunkId);
    if (!s) {
      s = new Set();
      consumedRemoved.set(hunkId, s);
    }
    for (const i of idx) s.add(i);
  };
  const takeAdded = (hunkId: string, idx: number[]) => {
    let s = consumedAdded.get(hunkId);
    if (!s) {
      s = new Set();
      consumedAdded.set(hunkId, s);
    }
    for (const i of idx) s.add(i);
  };

  const result = new Map<string, HunkMoves>();
  const movesFor = (hunkId: string): HunkMoves => {
    let m = result.get(hunkId);
    if (!m) {
      m = { movedOut: new Set(), movedIn: new Set(), counterparts: [] };
      result.set(hunkId, m);
    }
    return m;
  };
  const addCounterpart = (hunkId: string, c: MoveCounterpart) => {
    const m = movesFor(hunkId);
    const dup = m.counterparts.some(
      (x) => x.hunkId === c.hunkId && x.path === c.path && x.direction === c.direction,
    );
    if (!dup) m.counterparts.push(c);
  };

  for (const from of entries) {
    const removed = from.removed;
    for (let i = 0; i < removed.length; i++) {
      if (isRemovedTaken(from.hunk.id, i)) continue;
      const norm = normalize(removed[i]);
      if (!isSignificant(norm)) continue;

      const candidates = (addedIndex.get(norm) ?? []).filter(
        (c) => !isAddedTaken(c.entry.hunk.id, c.idx),
      );
      if (candidates.length === 0) continue;

      let best: { candidate: AddedOccurrence; run: Run; sig: number } | null = null;
      for (const candidate of candidates) {
        const run = extendRun(
          removed,
          candidate.entry.added,
          i,
          candidate.idx,
          (idx) => isRemovedTaken(from.hunk.id, idx),
          (idx) => isAddedTaken(candidate.entry.hunk.id, idx),
        );
        const sig = countSignificant(removed, run.removedIdx);
        if (sig >= MIN_SIGNIFICANT_LINES && (!best || sig > best.sig)) {
          best = { candidate, run, sig };
        }
      }
      if (!best) continue;

      const { candidate, run } = best;
      takeRemoved(from.hunk.id, run.removedIdx);
      takeAdded(candidate.entry.hunk.id, run.addedIdx);

      const outMoves = movesFor(from.hunk.id);
      for (const ri of run.removedIdx) outMoves.movedOut.add(ri);
      const inMoves = movesFor(candidate.entry.hunk.id);
      for (const ai of run.addedIdx) inMoves.movedIn.add(ai);

      addCounterpart(from.hunk.id, {
        path: candidate.entry.path,
        hunkId: candidate.entry.hunk.id,
        direction: "out",
      });
      addCounterpart(candidate.entry.hunk.id, {
        path: from.path,
        hunkId: from.hunk.id,
        direction: "in",
      });
    }
  }

  return result;
}
