import {
  keyToString,
  loadState,
  readFilesJson,
  stateRoot,
  type PrKey,
  liveUnits,
} from "@reviewer/core";

/**
 * "How much of this PR actually needs a careful read" — badged onto the PR
 * list so the extremes (skim-it-in-a-minute vs. block-off-time) stand out
 * without opening the PR.
 *
 * Thresholds were calibrated against the user's 29 analyzed PRs at the time
 * this was written: median must-read lines ~710, p25 ~165, p75 ~1330. They
 * are deliberately conservative — only PRs clearly outside the normal spread
 * get a badge; everything in between (including most of the p25-p75 band)
 * gets none rather than risk crying wolf.
 */
const FAST_MAX_LINES = 150;
const FAST_MAX_RISKS = 1;
const FAST_MAX_MUST_READ_UNITS = 5;

const HEAVY_MIN_LINES = 1500;
/** The lower-line "heavy" path also demands real risk surface, not just size. */
const HEAVY_MODERATE_LINES = 1200;
const HEAVY_MODERATE_RISKS = 4;

/**
 * A must-read line is not a must-read line: 170 lines of generated sqlc
 * queries or the same panel wiring repeated across three channels skim far
 * faster than 170 lines of novel core logic, and the analysis already labels
 * that difference as the unit's `kind`. Weighting by kind is what kept a
 * wide-but-repetitive PR (8327: 1554 raw must-read lines, ~670 of them
 * connective-tissue, reviewed quickly in practice) from wearing a "heavy"
 * badge it didn't deserve. Unknown kinds land in the middle rather than at
 * either extreme.
 */
const KIND_WEIGHTS: Record<string, number> = {
  "core-logic": 1.0,
  "connective-tissue": 0.4,
  wiring: 0.3,
  ripple: 0.3,
  tests: 0.25,
  docs: 0.1,
};
const DEFAULT_KIND_WEIGHT = 0.5;

export type EffortBadge = "fast" | "heavy" | null;

export interface ReviewEffort {
  /** changed lines (added+removed) across the union of must-read units' hunks */
  mustReadLines: number;
  /** the same lines discounted by unit kind (see KIND_WEIGHTS) — what the badge reads */
  weightedMustReadLines: number;
  mustReadUnits: number;
  riskCount: number;
  badge: EffortBadge;
}

function badgeFor(mustReadLines: number, riskCount: number, mustReadUnits: number): EffortBadge {
  if (
    mustReadLines < FAST_MAX_LINES &&
    riskCount <= FAST_MAX_RISKS &&
    mustReadUnits <= FAST_MAX_MUST_READ_UNITS
  ) {
    return "fast";
  }
  if (
    mustReadLines >= HEAVY_MIN_LINES ||
    (mustReadLines >= HEAVY_MODERATE_LINES && riskCount >= HEAVY_MODERATE_RISKS)
  ) {
    return "heavy";
  }
  return null;
}

interface CacheEntry {
  result: ReviewEffort;
}

const cache = new Map<string, CacheEntry>();

/** Tests, and anything that wants the next call to recompute from scratch. */
export function clearEffortCache(): void {
  cache.clear();
}

/**
 * Derives the review-effort badge for one PR from its folded state + the
 * files.json of the revision that state was analyzed against. `null` means
 * "nothing to badge" — no analysis on record — which is distinct from a
 * computed `badge: null` (analyzed, but effort lands in the unbadged middle).
 *
 * Revision drift (a unit's hunk id no longer present in that files.json) is
 * tolerated, not thrown on: the hunk simply contributes 0 lines. Analysis and
 * revisions are appended independently, so a hunk id briefly outliving the
 * files.json it came from is expected, not corrupt state.
 */
export function reviewEffort(key: PrKey, root = stateRoot()): ReviewEffort | null {
  const state = loadState(key, root);
  // Husks (units whose hunks all left the PR) have no lines to read and no
  // bearing on the remaining effort.
  const units = liveUnits(state);
  if (units.length === 0) return null;

  const revision = state.analysisRevision ?? state.currentRevision;
  // Keyed on what the badge is computed from, not just the analysis revision:
  // a new revision (hunks archived, units turned into husks) or an
  // incremental set-unit patch changes the must-read surface without a new
  // analysis-set, and must not leave a stale badge behind.
  const unitsSig = units
    .map((u) => `${u.id}:${u.kind}:${u.attention}:${u.riskFlags.length}:${u.hunkIds.join(",")}`)
    .join("|");
  const cacheKey = `${root}#${keyToString(key)}#${revision}#${state.currentRevision}#${unitsSig}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit.result;

  const hunkLines = new Map<string, number>();
  try {
    const filesJson = readFilesJson(key, revision, root);
    for (const file of filesJson.files) {
      for (const hunk of file.hunks) {
        hunkLines.set(hunk.id, hunk.addedLines.length + hunk.removedLines.length);
      }
    }
  } catch {
    // No files.json for that revision (e.g. it was pruned) — every hunk
    // contributes 0 lines rather than failing the whole computation.
  }

  const mustReadUnitList = units.filter((u) => u.attention === "must-read");
  const mustReadHunkIds = new Set(mustReadUnitList.flatMap((u) => u.hunkIds));
  let mustReadLines = 0;
  for (const id of mustReadHunkIds) mustReadLines += hunkLines.get(id) ?? 0;

  // Weighted over the same deduped hunk set as the raw count: each hunk is
  // counted once, at the highest kind-weight among the must-read units that
  // claim it, so raw and weighted stay comparable when units share a hunk.
  const hunkWeight = new Map<string, number>();
  for (const u of mustReadUnitList) {
    const w = KIND_WEIGHTS[u.kind] ?? DEFAULT_KIND_WEIGHT;
    for (const id of u.hunkIds) {
      hunkWeight.set(id, Math.max(hunkWeight.get(id) ?? 0, w));
    }
  }
  let weightedMustReadLines = 0;
  for (const [id, w] of hunkWeight) weightedMustReadLines += (hunkLines.get(id) ?? 0) * w;
  weightedMustReadLines = Math.round(weightedMustReadLines);

  const riskFlags = new Set(units.flatMap((u) => u.riskFlags));
  const riskCount = riskFlags.size;
  const mustReadUnits = mustReadUnitList.length;

  const result: ReviewEffort = {
    mustReadLines,
    weightedMustReadLines,
    mustReadUnits,
    riskCount,
    badge: badgeFor(weightedMustReadLines, riskCount, mustReadUnits),
  };
  cache.set(cacheKey, { result });
  return result;
}
