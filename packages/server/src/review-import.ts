import {
  initPr,
  keyToString,
  listPrs,
  searchReviewRequestedPrs,
  stateRoot,
  type PrKey,
  type RepoKey,
} from "@reviewer/core";
import { HttpError } from "./http-error.js";
import { startAnalysis } from "./analysis.js";

/**
 * Bulk import of open PRs where the authenticated user's review is requested
 * — the repo-scoped counterpart of pasting one PR URL at a time into
 * `POST /api/prs`. Shared by the manual "import review requests" action (see
 * app.ts) and the background poller (review-watch.ts), which is why the
 * "since" math lives in one place (`importReviewRequestsSince`) with the
 * days-based wrapper on top.
 */

export interface ImportResult {
  imported: string[];
  alreadyTracked: string[];
  failed: { key: string; error: string }[];
}

export interface ImportOptions {
  /** Whether a newly imported PR also gets an analysis run queued. Default true. */
  analyze?: boolean;
}

/**
 * Every PR in the repo already tracked locally, keyed the same way
 * `searchReviewRequestedPrs` numbers them — including archived ones. An
 * archived PR is still "tracked": re-importing it would resurrect it into the
 * active list behind the reader's back, which archiving exists to prevent.
 */
function trackedNumbers(repo: RepoKey, root: string): Set<number> {
  const tracked = new Set<number>();
  for (const key of listPrs(root)) {
    if (key.host === repo.host && key.owner === repo.owner && key.repo === repo.repo) {
      tracked.add(key.number);
    }
  }
  return tracked;
}

/**
 * Import every open, review-requested PR of `repo` updated since `since`,
 * exactly as `POST /api/prs` would for each one: `initPr` then (unless
 * `opts.analyze === false`) `startAnalysis`. Already-tracked PRs (including
 * archived ones) are skipped and reported, not resurrected. One PR's failure
 * is isolated — the caller gets a partial result rather than a thrown error.
 */
export function importReviewRequestsSince(
  repo: RepoKey,
  since: Date,
  root = stateRoot(),
  opts: ImportOptions = {},
): ImportResult {
  const result: ImportResult = { imported: [], alreadyTracked: [], failed: [] };
  const analyze = opts.analyze ?? true;

  const candidates = searchReviewRequestedPrs(repo, since.toISOString());
  const tracked = trackedNumbers(repo, root);

  for (const candidate of candidates) {
    const key: PrKey = { ...repo, number: candidate.number };
    const keyStr = keyToString(key);
    if (tracked.has(candidate.number)) {
      result.alreadyTracked.push(keyStr);
      continue;
    }
    try {
      initPr(key, root);
      if (analyze) {
        try {
          startAnalysis(key, root);
        } catch (err) {
          // A 409 means an analysis is already queued/running for this PR
          // (init's own refresh can trigger one indirectly via other callers,
          // or a concurrent import raced us) — that is success, not failure.
          if (!(err instanceof HttpError) || err.status !== 409) throw err;
        }
      }
      result.imported.push(keyStr);
    } catch (err) {
      result.failed.push({ key: keyStr, error: (err as Error).message });
    }
  }

  return result;
}

/** Days-based convenience wrapper: `since = now - days*24h`. */
export function importReviewRequests(
  repo: RepoKey,
  days: number,
  root = stateRoot(),
  opts: ImportOptions = {},
): ImportResult {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return importReviewRequestsSince(repo, since, root, opts);
}
