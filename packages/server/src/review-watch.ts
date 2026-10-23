import { log } from "./log.js";
import { listRepos, readRepoConfig, repoKeyToString, stateRoot } from "@reviewer/core";
import { importOwnPrsSince, importReviewRequestsSince } from "./review-import.js";
import { sweepPrStatuses } from "./status-sweep.js";

/**
 * Per-repo polling for review requests and own PRs. Opt-in (`repo.json` flags,
 * a machine-local setting — see schemas.ts), and deliberately dumb: every
 * tick re-lists every tracked repo and re-reads its config fresh off disk, so
 * flipping the checkbox in the UI takes effect on the next tick with no
 * server restart and no in-memory registry to keep in sync.
 *
 * Each tick also sweeps the status of every PR already tracked (state, review
 * decision, title — see status-sweep.ts), for every repo, watched or not: it
 * only touches PRs you added, so it needs no opt-in beyond this poller's.
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
/** Delay before the first pass after startup. */
const STARTUP_TICK_MS = 15_000;

export interface WatchRepoStatus {
  checkedAt: string;
  imported: number;
  error?: string;
  own?: { imported: number; error?: string };
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
 * One pass over every tracked repo: independently import review requests and
 * own PRs when their watch flags are on and the repo is not archived. A single repo's `gh` failure
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
      log.warn("watch", `${rkeyStr}: could not read config: ${(err as Error).message}`);
      continue;
    }
    // An archived repo is on the shelf as a whole: importing new PRs into it
    // would bring it back behind the reader's back. Its switches stay as they
    // were, so unarchiving resumes polling on the next tick.
    if (config.archived === true || (config.watchReviews !== true && config.watchOwn !== true)) {
      delete nextRepos[rkeyStr];
      continue;
    }
    const repoStatus: WatchRepoStatus = { checkedAt: now.toISOString(), imported: 0 };
    nextRepos[rkeyStr] = repoStatus;
    for (const [enabled, kind, importPrs] of [
      [config.watchReviews, "review requests", importReviewRequestsSince],
      [config.watchOwn, "own PRs", importOwnPrsSince],
    ] as const) {
      if (enabled !== true) continue;
      const loopStatus: { imported: number; error?: string } =
        kind === "own PRs" ? (repoStatus.own = { imported: 0 }) : repoStatus;
      try {
        const result = await importPrs(repo, since, root, { analyze });
        loopStatus.imported = result.imported.length;
        if (result.imported.length) log.info("watch", `${rkeyStr} ${kind} imported`, { prs: result.imported.length });
        if (result.failed.length) {
          loopStatus.error = result.failed.map((f) => `${f.key} (${f.error})`).join(", ");
          log.warn("watch", `${rkeyStr} ${kind}: ${loopStatus.error}`);
        }
      } catch (err) {
        loopStatus.error = (err as Error).message;
        log.warn("watch", `${rkeyStr} ${kind}: ${loopStatus.error}`);
      }
    }
  }

  // After the imports, so PRs a tick just brought in are not asked about
  // twice. Per-repo failures are logged inside; this catch is for the rest.
  try {
    await sweepPrStatuses(root);
  } catch (err) {
    log.warn("watch", `status sweep: ${(err as Error).message}`);
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
  // One early pass, so statuses that went stale while the server was down
  // are caught up within seconds of starting rather than a full interval.
  const first = setTimeout(run, Math.min(STARTUP_TICK_MS, intervalMs));
  // Never hold the process open on its own — tests and one-shot CLI runs
  // must be able to exit without explicitly stopping the watcher.
  timer.unref?.();
  first.unref?.();

  return {
    stop: () => {
      clearInterval(timer);
      clearTimeout(first);
    },
    tick: run,
  };
}
