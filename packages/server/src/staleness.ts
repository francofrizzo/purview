import {
  fetchPullRequest,
  fetchReviewDecision,
  keyToString,
  loadState,
  readMeta,
  stateRoot,
  updateMeta,
  type Meta,
  type PrKey,
  type PrState,
  type ReviewDecision,
} from "@reviewer/core";

/**
 * Why the local copy of a PR is behind GitHub.
 *
 *  - `new-commits`  — the head sha moved (we only know *that* it moved, never
 *                     by how many commits: one REST call cannot tell us).
 *  - `base-moved`   — the PR's base sha moved under us, so the diff GitHub
 *                     shows is no longer the diff we stored.
 *  - `state-changed`— open/draft/merged/closed, or the aggregate review
 *                     decision, differs from what meta records.
 */
export type StalenessReason = "new-commits" | "base-moved" | "state-changed";

export interface StalenessResult {
  stale: boolean;
  reasons: StalenessReason[];
  upstreamHeadSha: string | null;
  localHeadSha: string | null;
  upstreamBaseSha: string | null;
  localBaseSha: string | null;
  upstreamState: PrState | null;
  localState: PrState | null;
  upstreamReviewDecision: ReviewDecision | null;
  localReviewDecision: ReviewDecision | null;
  /** ISO timestamp of the check this answer came from (not of this request). */
  checkedAt: string;
  /**
   * Set when the `gh` call failed. The endpoint still answers 200 with
   * `stale: false`: a staleness hint is an affordance, and a broken `gh` must
   * never take the PR view down with it.
   */
  error?: string;
}

/** How long one answer is reused before another `gh` call is spent. */
export const STALENESS_TTL_MS = 60_000;

interface CacheEntry {
  at: number;
  result: StalenessResult;
}

const cache = new Map<string, CacheEntry>();

/** Cache entries are scoped to the state dir so two roots never share one. */
const cacheKeyFor = (key: PrKey, root: string) => `${root}\u0000${keyToString(key)}`;

/** Tests, and anything that wants the next call to really hit `gh`. */
export function clearStalenessCache(key?: PrKey, root = stateRoot()): void {
  if (key) cache.delete(cacheKeyFor(key, root));
  else cache.clear();
}

export interface StalenessOptions {
  /** Injectable clock (ms since epoch); tests drive the TTL window with it. */
  now?: () => number;
  /** Ignore any cached answer and re-check. */
  force?: boolean;
}

function localRevision(key: PrKey, root: string) {
  const state = loadState(key, root);
  return state.revisions.find((r) => r.revision === state.currentRevision) ?? null;
}

/**
 * One cheap `gh api repos/{o}/{r}/pulls/{n}` (plus the best-effort GraphQL
 * review-decision query) compared against the current revision and meta.
 *
 * The answer is cached per PR for `STALENESS_TTL_MS`, failures included: the
 * UI polls this on focus and on an interval, and a `gh` that is failing is
 * exactly the case where hammering it helps least.
 *
 * Read-only with one deliberate exception: when the only thing that moved is
 * the PR's state or review decision, meta is patched in place so the home
 * page's chips stay honest without a full refresh. Revisions, hunks and the
 * event log are never touched here — that is `refreshPr`'s job.
 */
export function checkStaleness(
  key: PrKey,
  root = stateRoot(),
  opts: StalenessOptions = {},
): StalenessResult {
  const now = opts.now ?? Date.now;
  const cacheKey = cacheKeyFor(key, root);
  const at = now();
  if (!opts.force) {
    const hit = cache.get(cacheKey);
    if (hit && at - hit.at < STALENESS_TTL_MS) return hit.result;
  }

  const meta = readMeta(key, root);
  const current = localRevision(key, root);
  const localHeadSha = current?.headSha ?? null;
  const localBaseSha = current?.baseSha ?? null;
  const localState = meta.prState ?? null;
  const localReviewDecision = meta.reviewDecision ?? null;
  const checkedAt = new Date(at).toISOString();

  let result: StalenessResult;
  try {
    const pr = fetchPullRequest(key);
    // Best-effort, and `null` from it is indistinguishable from a failed
    // query — see the guard below.
    const upstreamReviewDecision = fetchReviewDecision(key);

    const reasons: StalenessReason[] = [];
    if (localHeadSha && pr.headSha && localHeadSha !== pr.headSha) reasons.push("new-commits");
    if (localBaseSha && pr.baseSha && localBaseSha !== pr.baseSha) reasons.push("base-moved");

    const stateMoved = localState !== null && localState !== pr.prState;
    // A `null` upstream decision is treated as "unknown", never as "cleared":
    // `fetchReviewDecision` swallows its own failures into `null`, and acting
    // on that would both raise a phantom hint and wipe a real decision out of
    // meta. Clearing a decision stays `refreshPr`'s job.
    const decisionMoved =
      upstreamReviewDecision !== null && upstreamReviewDecision !== localReviewDecision;
    if (stateMoved || decisionMoved) reasons.push("state-changed");

    result = {
      stale: reasons.length > 0,
      reasons,
      upstreamHeadSha: pr.headSha,
      localHeadSha,
      upstreamBaseSha: pr.baseSha,
      localBaseSha,
      upstreamState: pr.prState,
      localState,
      upstreamReviewDecision,
      localReviewDecision,
      checkedAt,
    };

    // The one write: cheap, and it keeps the PR list's chips from lying until
    // someone happens to refresh.
    const patch: Partial<Meta> = {};
    if (stateMoved) patch.prState = pr.prState;
    if (decisionMoved) patch.reviewDecision = upstreamReviewDecision;
    if (Object.keys(patch).length > 0) updateMeta(key, patch, root);
  } catch (err) {
    result = {
      stale: false,
      reasons: [],
      upstreamHeadSha: null,
      localHeadSha,
      upstreamBaseSha: null,
      localBaseSha,
      upstreamState: null,
      localState,
      upstreamReviewDecision: null,
      localReviewDecision,
      checkedAt,
      error: (err as Error).message,
    };
  }

  cache.set(cacheKey, { at, result });
  return result;
}
