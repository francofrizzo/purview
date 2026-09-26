import { listRepos, readRepoConfig, repoKeyToString, stateRoot } from "@reviewer/core";
import { importReviewRequestsSince } from "./review-import.js";

/**
 * Per-repo polling for review requests. Opt-in (`repo.json`'s `watchReviews`,
 * a machine-local setting — see schemas.ts), and deliberately dumb: every
 * tick re-lists every tracked repo and re-reads its config fresh off disk, so
 * flipping the checkbox in the UI takes effect on the next tick with no
 * server restart and no in-memory registry to keep in sync.
 */

export interface WatchDeps {
  /** How often to poll. Default 5 minutes. */
  intervalMs?: number;
  /** The sliding window each tick imports over. Default 24 hours. */
  windowMs?: number;
  now?: () => Date;
}

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_WINDOW_MS = 24 * 60 * 60_000;

export interface WatchRepoStatus {
  checkedAt: string;
  imported: number;
  error?: string;
}

export interface WatchStatus {
  lastTickAt: string | null;
  repos: Record<string, WatchRepoStatus>;
}

let status: WatchStatus = { lastTickAt: null, repos: {} };

/** Snapshot of the most recent tick, for the UI (`GET /api/repos`). */
export function getWatchStatus(): WatchStatus {
  return status;
}

/** Test-only: clear accumulated status between runs. */
export function resetWatchStatus(): void {
  status = { lastTickAt: null, repos: {} };
}

/** Drop one repo's last poll (it was removed from Purview). */
export function forgetWatchStatus(rkey: string): void {
  if (!(rkey in status.repos)) return;
  const { [rkey]: _gone, ...rest } = status.repos;
  status = { ...status, repos: rest };
}

/**
 * One pass over every tracked repo: import review requests for whichever ones
 * have `watchReviews` on and are not archived. A single repo's `gh` failure
 * (or anything else that goes wrong reading/importing it) is caught and
 * recorded against that repo alone — it must never take the other repos'
 * polling, or the loop itself, down with it.
 */
async function tick(root: string, deps: Required<Pick<WatchDeps, "windowMs" | "now">>, analyze: boolean): Promise<void> {
  const now = deps.now();
  const since = new Date(now.getTime() - deps.windowMs);
  const nextRepos: WatchStatus["repos"] = { ...status.repos };

  for (const repo of listRepos(root)) {
    const rkeyStr = repoKeyToString(repo);
    let config;
    try {
      config = readRepoConfig(repo, root);
    } catch (err) {
      nextRepos[rkeyStr] = {
        checkedAt: now.toISOString(),
        imported: 0,
        error: (err as Error).message,
      };
      console.warn(`[watch] ${rkeyStr}: could not read config: ${(err as Error).message}`);
      continue;
    }
    if (config.watchReviews !== true) continue;
    // An archived repo is on the shelf as a whole: importing new PRs into it
    // would bring it back behind the reader's back. Its `watchReviews` stays
    // as it was, so unarchiving resumes polling on the next tick.
    if (config.archived === true) continue;

    try {
      const result = importReviewRequestsSince(repo, since, root, { analyze });
      nextRepos[rkeyStr] = { checkedAt: now.toISOString(), imported: result.imported.length };
      if (result.failed.length > 0) {
        console.warn(
          `[watch] ${rkeyStr}: ${result.failed.length} PR(s) failed to import: ` +
            result.failed.map((f) => `${f.key} (${f.error})`).join(", "),
        );
      }
    } catch (err) {
      nextRepos[rkeyStr] = {
        checkedAt: now.toISOString(),
        imported: 0,
        error: (err as Error).message,
      };
      console.warn(`[watch] ${rkeyStr}: ${(err as Error).message}`);
    }
  }

  status = { lastTickAt: now.toISOString(), repos: nextRepos };
}

export interface ReviewWatch {
  stop(): void;
  tick(): Promise<void> | void;
}

/**
 * Start the poller. `PURVIEW_NO_WATCH` (any truthy value) disables it
 * entirely — set it to guarantee zero background `gh` calls, mirroring
 * `PURVIEW_AUTO_ANALYZE=0` for the analysis triggers. Callers pass
 * `deps.analyze` indirectly through the closure below (see index.ts): the env
 * auto-analyze switch is read at tick time, not once at startup, so flipping
 * it takes effect on the next poll too.
 */
export function startReviewWatch(
  root: string = stateRoot(),
  deps: WatchDeps & { analyzeAllowed?: () => boolean } = {},
): ReviewWatch {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS;
  const now = deps.now ?? (() => new Date());
  const analyzeAllowed = deps.analyzeAllowed ?? (() => true);

  // Exposed as `tick()` so tests can await one pass directly (with an
  // injected `now`) instead of racing a real interval.
  const run = () => tick(root, { windowMs, now }, analyzeAllowed());

  if (process.env.PURVIEW_NO_WATCH) {
    return { stop() {}, tick: run };
  }

  const timer = setInterval(run, intervalMs);
  // Never hold the process open on its own — tests and one-shot CLI runs
  // must be able to exit without explicitly stopping the watcher.
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
    tick: run,
  };
}
