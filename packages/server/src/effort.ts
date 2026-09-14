import {
  keyToString,
  loadState,
  readFilesJson,
  stateRoot,
  type PrKey,
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
const HEAVY_MODERATE_LINES = 1000;
const HEAVY_MODERATE_RISKS = 4;

export type EffortBadge = "fast" | "heavy" | null;

export interface ReviewEffort {
  /** changed lines (added+removed) across the union of must-read units' hunks */
  mustReadLines: number;
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
  if (state.units.length === 0) return null;

  const revision = state.analysisRevision ?? state.currentRevision;
  const cacheKey = `${root}#${keyToString(key)}#${revision}`;
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

  const mustReadUnitList = state.units.filter((u) => u.attention === "must-read");
  const mustReadHunkIds = new Set(mustReadUnitList.flatMap((u) => u.hunkIds));
  let mustReadLines = 0;
  for (const id of mustReadHunkIds) mustReadLines += hunkLines.get(id) ?? 0;

  const riskFlags = new Set(state.units.flatMap((u) => u.riskFlags));
  const riskCount = riskFlags.size;
  const mustReadUnits = mustReadUnitList.length;

  const result: ReviewEffort = {
    mustReadLines,
    mustReadUnits,
    riskCount,
    badge: badgeFor(mustReadLines, riskCount, mustReadUnits),
  };
  cache.set(cacheKey, { result });
  return result;
}
