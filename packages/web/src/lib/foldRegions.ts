/**
 * Fold regions: contiguous runs of rows a hunk can hide behind one placeholder
 * row, and the generic plumbing to find them. Moved-code blocks (see
 * moveDetection.ts) are the first fold kind; the run-finding primitive below
 * takes no opinion on *why* a row qualifies, so a later fold kind (a long
 * unchanged import block, say) can reuse it with its own candidate/exempt
 * predicates.
 */

import { isSignificantLine, type MoveCounterpart } from "./moveDetection";

/** One row's standing for a particular fold kind, in row-space order (a
 *  hunk's unified line index, or its split pair index — whichever the
 *  caller is folding over). */
export interface FoldSlot {
  /** does this row belong to a run of this fold kind at all? */
  candidate: boolean;
  /** does this row hold something the reader must not lose — a comment, a
   *  search hit, the active match? Poisons the whole run it falls in: that
   *  run is reported but never folds. */
  exempt: boolean;
  /** a non-candidate row with nothing of its own on it (blank, `}`, `);`…)
   *  that a run may step over — see {@link MAX_BRIDGE_ROWS}. Ignored on a
   *  candidate row. */
  bridge?: boolean;
}

/** A run steps over at most this many consecutive `bridge` rows between two
 *  of its candidates; the bridged rows fold with it. Two covers the shapes a
 *  real move leaves behind — a closing brace plus a blank line — without
 *  swallowing anything a reader would want to see. */
export const MAX_BRIDGE_ROWS = 2;

export interface FoldRun {
  /** inclusive row-space start */
  from: number;
  /** exclusive row-space end */
  to: number;
  /** true when any row inside carries something exempt (see FoldSlot) */
  exempt: boolean;
}

/**
 * Maximal runs of `candidate` rows, at least `minLength` long (bridged rows
 * included). A non-candidate row breaks a run — context, an unrelated change,
 * anything outside this fold kind — unless it is a `bridge` row and at most
 * `maxBridge` of them sit between two candidates: then the run steps over
 * them and they fold with it, so one moved block whose halves a `}` or a
 * blank line separates reads as one block. A gap that is not closed by a
 * further candidate is never part of the run: a run starts and ends on a
 * candidate.
 */
export function computeFoldRuns(slots: FoldSlot[], minLength: number, maxBridge = MAX_BRIDGE_ROWS): FoldRun[] {
  const runs: FoldRun[] = [];
  let start: number | null = null;
  /** exclusive end: one past the run's last candidate */
  let end = 0;
  let exempt = false;
  // the open gap since the last candidate, and whether it holds an exemption
  let gap = 0;
  let gapExempt = false;
  const flush = () => {
    if (start !== null && end - start >= minLength) runs.push({ from: start, to: end, exempt });
    start = null;
    exempt = false;
    gap = 0;
    gapExempt = false;
  };
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (slot.candidate) {
      if (start === null) start = i;
      // closing a gap pulls its rows (and anything exempt on them) into the run
      if (gap > 0 && gapExempt) exempt = true;
      gap = 0;
      gapExempt = false;
      if (slot.exempt) exempt = true;
      end = i + 1;
    } else if (start !== null && slot.bridge && gap < maxBridge) {
      gap++;
      if (slot.exempt) gapExempt = true;
    } else {
      flush();
    }
  }
  flush();
  return runs;
}

/* --------------------------------------------------- moved-block candidates */

export interface MoveIndexLike {
  removedIdx: (number | undefined)[];
  addedIdx: (number | undefined)[];
}

export interface HunkMovesLike {
  movedOut: Set<number>;
  movedIn: Set<number>;
}

/** A candidate row plus the moved-content index (`removedIdx`/`addedIdx`
 *  space) it carries, when it's a candidate — the index is what makes a fold
 *  region's key stable across a unified/split switch (see `moveFoldRegions`). */
export interface MoveCandidate {
  candidate: boolean;
  contentIdx?: number;
  /** a non-candidate row a run may step over (see FoldSlot.bridge): blank
   *  or punctuation only, by lib/moveDetection.ts's own notion of a line
   *  that carries nothing */
  bridge?: boolean;
}

/** A unified row, reduced to what candidacy needs. */
export interface UnifiedRowShape {
  type: string;
  content: string;
}

/** The non-candidate slot for a row: bridgeable when nothing on it is worth
 *  keeping in view (blank, `}`, `);`…); a real line always breaks a run. */
function nonCandidate(...contents: (string | undefined)[]): MoveCandidate {
  const bridge = contents.every((c) => c === undefined || !isSignificantLine(c));
  return bridge ? { candidate: false, bridge: true } : { candidate: false };
}

/**
 * Unified mode: one slot per unified row. A row is an "out" candidate when
 * it's a removed line in `movedOut`, an "in" candidate when it's an added
 * line in `movedIn`. Context and unrelated add/del rows are never
 * candidates: a significant one breaks a run, a blank or punctuation-only
 * one can be bridged over (see {@link computeFoldRuns}).
 */
export function unifiedMoveCandidates(
  rows: readonly UnifiedRowShape[],
  moveIndex: MoveIndexLike,
  moves: HunkMovesLike,
  kind: "in" | "out",
): MoveCandidate[] {
  return rows.map((row, i) => {
    if (kind === "out") {
      if (row.type !== "del") return nonCandidate(row.content);
      const idx = moveIndex.removedIdx[i];
      return idx !== undefined && moves.movedOut.has(idx)
        ? { candidate: true, contentIdx: idx }
        : nonCandidate(row.content);
    }
    if (row.type !== "add") return nonCandidate(row.content);
    const idx = moveIndex.addedIdx[i];
    return idx !== undefined && moves.movedIn.has(idx)
      ? { candidate: true, contentIdx: idx }
      : nonCandidate(row.content);
  });
}

/** One split pair's shape, reduced to what pairing needs: each side's row
 *  type (undefined when that side is a filler cell) and its unified index
 *  (buildSplitRows addresses both sides by the *unified* row index — see
 *  lib/diffModel.ts). */
export interface SplitPairShape {
  leftType?: string;
  leftUnifiedIndex?: number;
  leftContent?: string;
  rightType?: string;
  rightUnifiedIndex?: number;
  rightContent?: string;
}

/**
 * Split mode: one slot per pair, computed over the side that carries the
 * move (left/removed for "out", right/added for "in"). A pair still counts
 * when the *other* side is empty or itself moved — only a real, non-moved
 * line on the other side breaks the run, per the design.
 */
export function splitMoveCandidates(
  pairs: readonly SplitPairShape[],
  moveIndex: MoveIndexLike,
  moves: HunkMovesLike,
  kind: "in" | "out",
): MoveCandidate[] {
  return pairs.map((p) => {
    // a pair with nothing of note on either half can be bridged over
    const gap = () => nonCandidate(p.leftContent, p.rightContent);
    if (kind === "out") {
      if (p.leftType !== "del" || p.leftUnifiedIndex === undefined) return gap();
      const idx = moveIndex.removedIdx[p.leftUnifiedIndex];
      if (idx === undefined || !moves.movedOut.has(idx)) return gap();
      if (p.rightType === "add" && p.rightUnifiedIndex !== undefined) {
        const rIdx = moveIndex.addedIdx[p.rightUnifiedIndex];
        const rightMoved = rIdx !== undefined && moves.movedIn.has(rIdx);
        if (!rightMoved) return { candidate: false }; // a real line on the other side
      }
      return { candidate: true, contentIdx: idx };
    }
    if (p.rightType !== "add" || p.rightUnifiedIndex === undefined) return gap();
    const idx = moveIndex.addedIdx[p.rightUnifiedIndex];
    if (idx === undefined || !moves.movedIn.has(idx)) return gap();
    if (p.leftType === "del" && p.leftUnifiedIndex !== undefined) {
      const lIdx = moveIndex.removedIdx[p.leftUnifiedIndex];
      const leftMoved = lIdx !== undefined && moves.movedOut.has(lIdx);
      if (!leftMoved) return { candidate: false }; // a real line on the other side
    }
    return { candidate: true, contentIdx: idx };
  });
}

export const MIN_FOLD_LENGTH = 4;

export interface MoveFoldRegion {
  /** stable across a unified/split switch — keyed by the moved-content index
   *  space (removedIdx/addedIdx), not by row position */
  key: string;
  kind: "in" | "out";
  /** row-space bounds in whichever mode this was computed for */
  from: number;
  to: number;
  hidden: number;
  /** never folds — something inside needs to stay visible */
  exempt: boolean;
  label: string;
  /** moved-content index (removedIdx/addedIdx space) of the run's first row */
  contentFrom: number;
}

/** One label per fold direction, naming the counterpart file(s) the way the
 *  hunk header's own "moved" badge does, just spelled out in full. */
export function foldLabel(kind: "in" | "out", hidden: number, counterparts: MoveCounterpart[]): string {
  const paths = [...new Set(counterparts.filter((c) => c.direction === kind).map((c) => c.path))];
  const noun = hidden === 1 ? "line" : "lines";
  const verb = kind === "in" ? "from" : "to";
  const where =
    paths.length === 0 ? "" : paths.length === 1 ? ` ${verb} ${paths[0]}` : ` ${verb} ${paths.length} files`;
  return `${hidden} ${noun} moved${where}`;
}

/**
 * Candidates (from {@link unifiedMoveCandidates} or {@link splitMoveCandidates})
 * plus a parallel exemption flag per row, folded down into the regions the
 * diff pane renders a placeholder for.
 */
export function moveFoldRegions(params: {
  hunkId: string;
  kind: "in" | "out";
  candidates: MoveCandidate[];
  /** same length as `candidates`; true where that row must stay visible */
  exempt: boolean[];
  counterparts: MoveCounterpart[];
  minLength?: number;
}): MoveFoldRegion[] {
  const { hunkId, kind, candidates, exempt, counterparts, minLength = MIN_FOLD_LENGTH } = params;
  const slots: FoldSlot[] = candidates.map((c, i) => ({
    candidate: c.candidate,
    exempt: exempt[i] === true,
    bridge: c.bridge,
  }));
  const runs = computeFoldRuns(slots, minLength);
  return runs.map((run) => {
    const hidden = run.to - run.from;
    const contentFrom = candidates[run.from].contentIdx ?? run.from;
    return {
      key: `${hunkId}:${kind}:${contentFrom}`,
      kind,
      from: run.from,
      to: run.to,
      hidden,
      exempt: run.exempt,
      label: foldLabel(kind, hidden, counterparts),
      contentFrom,
    };
  });
}

/** The counterpart a fold band of this `kind` can jump to: the first one in
 *  the move's direction whose hunk is in the pane right now (`liveHunkIds`).
 *  Same reachability rule as the hunk header's "moved" badge — a counterpart
 *  shown in another unit is named in the label but offers no jump. */
export function reachableCounterpart(
  counterparts: readonly MoveCounterpart[],
  kind: "in" | "out",
  liveHunkIds: ReadonlySet<string>,
): MoveCounterpart | undefined {
  return counterparts.find((c) => c.direction === kind && liveHunkIds.has(c.hunkId));
}

/* ------------------------------------------------ open / folded state */

/** The hunk id a region key (`${hunkId}:${kind}:${contentFrom}`) belongs to.
 *  Parsed from the right, so a hunk id that itself contains a colon still
 *  round-trips. */
export function foldRegionHunkId(regionKey: string): string {
  const last = regionKey.lastIndexOf(":");
  const kindSep = last <= 0 ? -1 : regionKey.lastIndexOf(":", last - 1);
  return kindSep === -1 ? regionKey : regionKey.slice(0, kindSep);
}

/** Is this region currently hidden behind its placeholder? Exempt regions
 *  never fold; everything else folds unless the reader opened it. */
export function isFoldRegionFolded(region: MoveFoldRegion, opened: ReadonlySet<string>): boolean {
  return !region.exempt && !opened.has(region.key);
}

/** Flip one region between opened and folded. Takes the *region* key (see
 *  {@link MoveFoldRegion.key}) — never a rendered row's key, which carries a
 *  `fold:` prefix and would never match on read. */
export function toggleOpenedFoldRegion(opened: ReadonlySet<string>, regionKey: string): ReadonlySet<string> {
  const next = new Set(opened);
  if (next.has(regionKey)) next.delete(regionKey);
  else next.add(regionKey);
  return next;
}

/** The placeholder a folded region renders as. `key` is the virtualizer row
 *  key; `regionKey` is what open/fold state is keyed by. */
export interface FoldPlaceholder {
  key: string;
  regionKey: string;
  kind: "in" | "out";
  from: number;
  to: number;
  label: string;
  hidden: number;
}

export function foldPlaceholder(region: MoveFoldRegion): FoldPlaceholder {
  return {
    key: `fold:${region.key}`,
    regionKey: region.key,
    kind: region.kind,
    from: region.from,
    to: region.to,
    label: region.label,
    hidden: region.hidden,
  };
}

/**
 * Per hunk, by row-space start index: which regions are folded (render a
 * placeholder there and skip to `to`) and which are manually opened (render
 * rows as normal, with a "fold back up" control on the first one). Exempt
 * regions appear in neither — they can't fold, so there's nothing to offer.
 */
export function foldStartsFor(
  regions: readonly MoveFoldRegion[],
  opened: ReadonlySet<string>,
): { folded: Map<number, MoveFoldRegion>; opened: Map<number, MoveFoldRegion> } {
  const folded = new Map<number, MoveFoldRegion>();
  const open = new Map<number, MoveFoldRegion>();
  for (const region of regions) {
    if (region.exempt) continue;
    if (opened.has(region.key)) open.set(region.from, region);
    else folded.set(region.from, region);
  }
  return { folded, opened: open };
}

/** Regions the reader can no longer see have no business holding open state —
 *  same idiom as hunkCollapse.ts's `pruneCollapsed`, keyed by the hunk id a
 *  region's key is prefixed with. */
export function pruneOpenedFoldRegions(
  opened: ReadonlySet<string>,
  liveHunkIds: Iterable<string>,
): ReadonlySet<string> {
  const live = new Set(liveHunkIds);
  const keep = [...opened].filter((key) => live.has(foldRegionHunkId(key)));
  if (keep.length === opened.size) return opened;
  return new Set(keep);
}
