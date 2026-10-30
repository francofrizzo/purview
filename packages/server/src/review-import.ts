import {
  initPrAsync,
  keyToString,
  listPrs,
  readMeta,
  reviewRequestPatchAsync,
  searchOwnPrsAsync,
  searchReviewRequestedPrsAsync,
  stateRoot,
  updateMeta,
  type PrKey,
  type RepoKey,
} from "@reviewer/core";
import { readConfig } from "./config.js";
import { HttpError } from "./http-error.js";
import { localDiffSource } from "./pr-checkout.js";
import { startAnalysis } from "./analysis.js";
import { resolveAutoSharedAnalysis } from "./analysis-share-server.js";
import { reviewRequestDue } from "./review-request-refresh.js";
import { REVIEW_REQUEST_POLL_MS } from "./staleness.js";

/**
 * Bulk import of open PRs where the authenticated user's review is requested,
 * or that the user opened — the repo-scoped counterpart of pasting one PR URL at a time into
 * `POST /api/prs`. Shared by the manual "import review requests" action (see
 * app.ts) and the background poller (review-watch.ts), which is why the
 * "since" math lives in one place (`importReviewRequestsSince`) with the
 * days-based wrapper on top.
 */

export interface ImportResult {
  imported: string[];
  alreadyTracked: string[];
  failed: { key: string; error: string }[];
  /**
   * Additive: which of `imported`'s PRs got a shared analysis imported off
   * the PR itself instead of a fresh (paid) Claude run — the same
   * cost-avoidance check `POST /api/prs` does for a single interactive add,
   * applied here per PR. Unlike the interactive path, a shared analysis for a
   * *different* revision is never suggested here (nobody is present to
   * decide) — it just falls back to a normal analysis run, same as "not
   * found".
   */
  sharedImports: { key: string; author?: string; postedAt: string }[];
  /**
   * Archived PRs this import brought back: picked by hand, or (review
   * requests only) asked for your review again after you archived them.
   * Listed in `alreadyTracked` too.
   */
  unarchived: string[];
}

export interface ImportOptions {
  /** Whether a newly imported PR also gets an analysis run queued. Default true. */
  analyze?: boolean;
}

/** Where an import candidate came from. */
export type ImportSource = "requests" | "own";

/** One PR an import could bring in, for the reader to pick from. */
export interface ImportCandidate {
  number: number;
  title: string;
  updatedAt: string;
  author?: string;
  /** every search that found it */
  sources: ImportSource[];
  /** already in Purview (archived or not) */
  tracked: boolean;
  /** tracked, and on the archived shelf */
  archived: boolean;
}

/**
 * Every PR in the repo already tracked locally, by number, with whether it is
 * archived. An archived PR is still "tracked": a background import never
 * resurrects it into the active list (archiving exists to prevent exactly
 * that), except when your review is asked for again after you archived it.
 */
function trackedNumbers(repo: RepoKey, root: string): Map<number, { archived: boolean }> {
  const tracked = new Map<number, { archived: boolean }>();
  for (const key of listPrs(root)) {
    if (key.host === repo.host && key.owner === repo.owner && key.repo === repo.repo) {
      let archived = false;
      try {
        archived = readMeta(key, root).archived === true;
      } catch {
        // unreadable meta: still tracked, never touched
      }
      tracked.set(key.number, { archived });
    }
  }
  return tracked;
}

/**
 * Import every open, review-requested PR of `repo` updated since `since`,
 * exactly as `POST /api/prs` would for each one: `initPr` then (unless
 * `opts.analyze === false`) `startAnalysis`. Already-tracked PRs are skipped
 * and reported. An archived one stays archived unless the request on it is
 * newer than the archiving (see `bringBackOnFreshRequest`). One PR's failure
 * is isolated — the caller gets a partial result rather than a thrown error.
 */
export async function importReviewRequestsSince(
  repo: RepoKey,
  since: Date,
  root = stateRoot(),
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const candidates = await searchReviewRequestedPrsAsync(repo, since.toISOString());
  return importCandidates(repo, candidates, root, opts, "fresh-request");
}

/** The same import for the PRs you (or the extra logins in Settings) opened. */
export async function importOwnPrsSince(
  repo: RepoKey,
  since: Date,
  root = stateRoot(),
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const candidates = await searchOwnPrsAsync(repo, since.toISOString(), readConfig(root).extraAuthors);
  return importCandidates(repo, candidates, root, opts, "never");
}

/**
 * What an import over the last `days` would find, without importing
 * anything: both searches merged by PR number, each marked with where it was
 * found and whether Purview already tracks it. Newest update first.
 */
export async function findImportCandidates(
  repo: RepoKey,
  days: number,
  sources: readonly ImportSource[],
  root = stateRoot(),
): Promise<ImportCandidate[]> {
  const since = daysAgo(days).toISOString();
  const tracked = trackedNumbers(repo, root);
  const found = new Map<number, ImportCandidate>();
  const add = (prs: { number: number; title: string; updatedAt: string; author?: string }[], source: ImportSource) => {
    for (const pr of prs) {
      const known = found.get(pr.number);
      if (known) {
        if (!known.sources.includes(source)) known.sources.push(source);
        continue;
      }
      const t = tracked.get(pr.number);
      found.set(pr.number, {
        number: pr.number,
        title: pr.title,
        updatedAt: pr.updatedAt,
        ...(pr.author ? { author: pr.author } : {}),
        sources: [source],
        tracked: t !== undefined,
        archived: t?.archived === true,
      });
    }
  };
  if (sources.includes("requests")) add(await searchReviewRequestedPrsAsync(repo, since), "requests");
  if (sources.includes("own")) add(await searchOwnPrsAsync(repo, since, readConfig(root).extraAuthors), "own");
  return [...found.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.number - a.number);
}

/**
 * Import exactly the PRs the reader picked. A picked PR that is archived is
 * brought back, as adding it by URL would; one already active is reported as
 * tracked and left alone.
 */
export async function importSelectedPrs(
  repo: RepoKey,
  numbers: readonly number[],
  root = stateRoot(),
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const unique = [...new Set(numbers)].map((number) => ({ number }));
  return importCandidates(repo, unique, root, opts, "always");
}

/**
 * Whether an archived, review-requested PR should come back: the request on
 * it now is newer than the archiving. Rate-limited like every other
 * review-request lookup, so a PR you archived on purpose while it waited on
 * you costs one cheap lookup every few minutes at most. A PR archived before
 * `archivedAt` was kept falls back to the request it had then; with neither,
 * it is stamped now and only a later request brings it back.
 */
async function bringBackOnFreshRequest(key: PrKey, root: string, now = Date.now()): Promise<boolean> {
  const meta = readMeta(key, root);
  if (!reviewRequestDue(meta.reviewRequestCheckedAt, now, REVIEW_REQUEST_POLL_MS)) return false;
  const patch = await reviewRequestPatchAsync(key, meta.prState, root, now);
  const threshold = meta.archivedAt ?? meta.reviewRequest?.at;
  if (!threshold) {
    updateMeta(key, { ...patch, archivedAt: new Date(now).toISOString() }, root);
    return false;
  }
  const request = patch.reviewRequest;
  if (request && Date.parse(request.at) > Date.parse(threshold)) {
    updateMeta(key, { ...patch, archived: false }, root);
    return true;
  }
  updateMeta(key, patch, root);
  return false;
}

async function importCandidates(
  repo: RepoKey,
  candidates: { number: number }[],
  root: string,
  opts: ImportOptions,
  unarchive: "never" | "fresh-request" | "always",
): Promise<ImportResult> {
  const result: ImportResult = { imported: [], alreadyTracked: [], failed: [], sharedImports: [], unarchived: [] };
  const analyze = opts.analyze ?? true;

  const tracked = trackedNumbers(repo, root);

  for (const candidate of candidates) {
    const key: PrKey = { ...repo, number: candidate.number };
    const keyStr = keyToString(key);
    const known = tracked.get(candidate.number);
    if (known) {
      result.alreadyTracked.push(keyStr);
      if (!known.archived || unarchive === "never") continue;
      try {
        if (unarchive === "always") {
          updateMeta(key, { archived: false }, root);
          result.unarchived.push(keyStr);
        } else if (await bringBackOnFreshRequest(key, root)) {
          result.unarchived.push(keyStr);
        }
      } catch (err) {
        result.failed.push({ key: keyStr, error: (err as Error).message });
      }
      continue;
    }
    try {
      await initPrAsync(key, root, { localDiff: localDiffSource(root) });
      if (analyze) {
        // Cost-avoidance: a shared analysis already on the PR for this exact
        // revision is free to import and replaces the paid run entirely.
        const auto = await resolveAutoSharedAnalysis(key, root);
        if (auto.imported) {
          result.sharedImports.push({
            key: keyStr,
            author: auto.sharedAnalysis?.author,
            postedAt: auto.sharedAnalysis?.postedAt ?? "",
          });
        } else {
          try {
            startAnalysis(key, root);
          } catch (err) {
            // A 409 means an analysis is already queued/running for this PR
            // (init's own refresh can trigger one indirectly via other callers,
            // or a concurrent import raced us) — that is success, not failure.
            if (!(err instanceof HttpError) || err.status !== 409) throw err;
          }
        }
      }
      result.imported.push(keyStr);
    } catch (err) {
      result.failed.push({ key: keyStr, error: (err as Error).message });
    }
  }

  return result;
}

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

/** Days-based convenience wrapper: `since = now - days*24h`. */
export async function importReviewRequests(
  repo: RepoKey,
  days: number,
  root = stateRoot(),
  opts: ImportOptions = {},
): Promise<ImportResult> {
  return await importReviewRequestsSince(repo, daysAgo(days), root, opts);
}

/** Days-based wrapper for your own PRs. */
export async function importOwnPrs(
  repo: RepoKey,
  days: number,
  root = stateRoot(),
  opts: ImportOptions = {},
): Promise<ImportResult> {
  return await importOwnPrsSince(repo, daysAgo(days), root, opts);
}

/** Two results as one: what a two-source import reports. */
export function mergeImportResults(a: ImportResult, b: ImportResult): ImportResult {
  const uniq = (xs: string[]) => [...new Set(xs)];
  const imported = uniq([...a.imported, ...b.imported]);
  return {
    imported,
    // the second search finds what the first just imported: not "already tracked"
    alreadyTracked: uniq([...a.alreadyTracked, ...b.alreadyTracked]).filter((k) => !imported.includes(k)),
    failed: [...a.failed, ...b.failed],
    sharedImports: [...a.sharedImports, ...b.sharedImports],
    unarchived: uniq([...a.unarchived, ...b.unarchived]),
  };
}
