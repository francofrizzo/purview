/**
 * Move detection (git `--color-moved` spirit): a contiguous run of removed
 * lines that reappears, in order, as added lines elsewhere in the same
 * revision is a code move — even buried inside a hunk that also has genuinely
 * new changes around it. Line-RUN granularity, not whole-hunk: a whole-hunk
 * similarity score is structurally blind to a function extraction that shares
 * a hunk with unrelated edits, which is exactly the shape real refactors take
 * (validated on a real PR where whole-hunk matching scored zero against a
 * 39-line extraction).
 *
 * MIRRORED IMPLEMENTATION — packages/web/src/lib/moveDetection.ts is the
 * same algorithm over the web's own types, because the web package
 * deliberately does not depend on core (its API types are a standalone
 * contract). The two copies share their behavioral contract through matching
 * test vectors; change one, change both, and keep the constants identical.
 *
 * On normalization: hunk identity (hunk-id.ts) strips only the +/- marker —
 * exact content, by design, for a stable hash. Move detection wants the
 * opposite: a moved block that picked up a reindent or a blank line should
 * still read as the same block. So this trims each line and requires a line
 * be "significant" before it can seed or count toward a run — otherwise a
 * handful of `}` or `import (` lines lining up between unrelated hunks would
 * read as a move.
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
  /** counterpart hunks, deduped, order = first occurrence */
  counterparts: MoveCounterpart[];
}

/** The structural slice of FileDiff this needs; keeps callers flexible. */
export interface MoveFile {
  path: string;
  hunks: { id: string; addedLines: string[]; removedLines: string[] }[];
}

const MIN_SIGNIFICANT_LINES = 3;
const MIN_SIGNIFICANT_LENGTH = 8;
const WORD_RUN = /[A-Za-z0-9_]{4,}/;

function normalize(line: string): string {
  return line.trim();
}

function isSignificant(normalized: string): boolean {
  if (normalized.length === 0) return false;
  return normalized.length >= MIN_SIGNIFICANT_LENGTH || WORD_RUN.test(normalized);
}

interface Entry {
  id: string;
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
 * match exactly (post-normalization); blank-normalized lines on either side
 * are swept in for free so blank padding never breaks a run.
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
 * Detect moved line-runs across every file of one revision. Greedy, document
 * order, longest qualifying run per seed line wins and consumes both sides —
 * same contract as the web implementation (see the mirroring note on top).
 */
export function detectMoves(files: MoveFile[]): Map<string, HunkMoves> {
  const entries: Entry[] = [];
  for (const file of files) {
    for (const hunk of file.hunks) {
      entries.push({
        id: hunk.id,
        path: file.path,
        added: hunk.addedLines ?? [],
        removed: hunk.removedLines ?? [],
      });
    }
  }

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
  const isRemovedTaken = (id: string, i: number) => consumedRemoved.get(id)?.has(i) ?? false;
  const isAddedTaken = (id: string, i: number) => consumedAdded.get(id)?.has(i) ?? false;
  const take = (map: Map<string, Set<number>>, id: string, idx: number[]) => {
    let s = map.get(id);
    if (!s) {
      s = new Set();
      map.set(id, s);
    }
    for (const i of idx) s.add(i);
  };

  const result = new Map<string, HunkMoves>();
  const movesFor = (id: string): HunkMoves => {
    let m = result.get(id);
    if (!m) {
      m = { movedOut: new Set(), movedIn: new Set(), counterparts: [] };
      result.set(id, m);
    }
    return m;
  };
  const addCounterpart = (id: string, c: MoveCounterpart) => {
    const m = movesFor(id);
    const dup = m.counterparts.some(
      (x) => x.hunkId === c.hunkId && x.path === c.path && x.direction === c.direction,
    );
    if (!dup) m.counterparts.push(c);
  };

  for (const from of entries) {
    const removed = from.removed;
    for (let i = 0; i < removed.length; i++) {
      if (isRemovedTaken(from.id, i)) continue;
      const norm = normalize(removed[i]);
      if (!isSignificant(norm)) continue;

      const candidates = (addedIndex.get(norm) ?? []).filter(
        (c) => !isAddedTaken(c.entry.id, c.idx),
      );
      if (candidates.length === 0) continue;

      let best: { candidate: AddedOccurrence; run: Run; sig: number } | null = null;
      for (const candidate of candidates) {
        const run = extendRun(
          removed,
          candidate.entry.added,
          i,
          candidate.idx,
          (idx) => isRemovedTaken(from.id, idx),
          (idx) => isAddedTaken(candidate.entry.id, idx),
        );
        const sig = countSignificant(removed, run.removedIdx);
        if (sig >= MIN_SIGNIFICANT_LINES && (!best || sig > best.sig)) {
          best = { candidate, run, sig };
        }
      }
      if (!best) continue;

      const { candidate, run } = best;
      take(consumedRemoved, from.id, run.removedIdx);
      take(consumedAdded, candidate.entry.id, run.addedIdx);

      const outMoves = movesFor(from.id);
      for (const ri of run.removedIdx) outMoves.movedOut.add(ri);
      const inMoves = movesFor(candidate.entry.id);
      for (const ai of run.addedIdx) inMoves.movedIn.add(ai);

      addCounterpart(from.id, { path: candidate.entry.path, hunkId: candidate.entry.id, direction: "out" });
      addCounterpart(candidate.entry.id, { path: from.path, hunkId: from.id, direction: "in" });
    }
  }

  return result;
}

export interface MovePairSummary {
  fromPath: string;
  toPath: string;
  /** moved-out line count on the source side (blank padding included) */
  lines: number;
  /** hunk ids involved, source side then target side */
  fromHunkIds: string[];
  toHunkIds: string[];
}

/**
 * Aggregate per (source path, target path) — the shape a prompt (or a log
 * line) wants, sorted by moved-line volume.
 */
export function summarizeMoves(files: MoveFile[]): MovePairSummary[] {
  const moves = detectMoves(files);
  const hunkPath = new Map<string, string>();
  for (const f of files) for (const h of f.hunks) hunkPath.set(h.id, f.path);

  const byPair = new Map<string, MovePairSummary>();
  for (const [hunkId, m] of moves) {
    if (m.movedOut.size === 0) continue;
    for (const c of m.counterparts) {
      if (c.direction !== "out") continue;
      const key = `${hunkPath.get(hunkId)} ${c.path}`;
      let s = byPair.get(key);
      if (!s) {
        s = {
          fromPath: hunkPath.get(hunkId) ?? "?",
          toPath: c.path,
          lines: 0,
          fromHunkIds: [],
          toHunkIds: [],
        };
        byPair.set(key, s);
      }
      if (!s.fromHunkIds.includes(hunkId)) s.fromHunkIds.push(hunkId);
      if (!s.toHunkIds.includes(c.hunkId)) s.toHunkIds.push(c.hunkId);
    }
    const path = hunkPath.get(hunkId);
    for (const c of m.counterparts) {
      if (c.direction !== "out") continue;
      const s = byPair.get(`${path} ${c.path}`);
      // movedOut lines are attributed once per source hunk; when one hunk
      // feeds several targets this over-counts per pair, which is fine for
      // a sorted summary — pair-splitting the sets buys nothing a prompt
      // needs.
      if (s) s.lines += m.movedOut.size / m.counterparts.filter((x) => x.direction === "out").length;
    }
  }
  const out = [...byPair.values()];
  for (const s of out) s.lines = Math.round(s.lines);
  return out.sort((a, b) => b.lines - a.lines);
}
