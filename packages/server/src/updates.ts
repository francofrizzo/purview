import { execFile } from "node:child_process";
import { compareVersions } from "./changelog.js";
import { repoRoot } from "./skill-paths.js";

/**
 * "Is there a newer Purview than the one running?" for a git checkout: the
 * release signal is a `vYYYY.M.D.N` tag on origin (see AGENTS.md), so the
 * newest such tag on the remote, compared with the running version, is the
 * whole answer. One `git ls-remote --tags origin` a day, at most; the result
 * is held in memory, and a failed check (offline, no remote) is held too, so a
 * laptop on a train does not retry on every page load.
 */

export interface UpdateStatus {
  /** the newest release on origin that is newer than `running`; null when up to date or unknown */
  latest: string | null;
  /** when the remote was last asked, ISO; null before the first check */
  checkedAt: string | null;
}

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** how long a request waits for a stale check before answering with what it has */
const WAIT_MS = 4_000;
const LS_REMOTE_TIMEOUT_MS = 10_000;
const TAG_RE = /refs\/tags\/v(\d{4}\.\d{1,2}\.\d{1,2}\.\d+)(\^\{\})?$/;

/** The newest release tag in `git ls-remote --tags` output, as a version; null when there is none. */
export function newestReleaseTag(lsRemote: string): string | null {
  let best: string | null = null;
  for (const line of lsRemote.split("\n")) {
    const m = TAG_RE.exec(line.trim());
    if (!m) continue;
    if (best === null || compareVersions(m[1], best) > 0) best = m[1];
  }
  return best;
}

/** `latest` for the response: the remote's newest release only when it is ahead of what runs. */
export function newerThan(running: string | null, remoteNewest: string | null): string | null {
  if (!remoteNewest) return null;
  if (!running) return remoteNewest;
  return compareVersions(remoteNewest, running) > 0 ? remoteNewest : null;
}

export type LsRemote = () => Promise<string>;

const gitLsRemote: LsRemote = () =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      ["ls-remote", "--tags", "origin"],
      { cwd: repoRoot(), timeout: LS_REMOTE_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout) => (err ? reject(err) : resolve(stdout.toString())),
    );
  });

export interface UpdateCheckerDeps {
  lsRemote?: LsRemote;
  now?: () => number;
  intervalMs?: number;
  waitMs?: number;
}

export interface UpdateChecker {
  /**
   * The status for `running`. A stale cache triggers one check; the caller
   * waits for it up to `waitMs` so the first page after a day usually gets
   * the answer, and a slow network gets the previous answer instead of a
   * hung request.
   */
  status(running: string | null): Promise<UpdateStatus>;
  /** Ask origin now, whatever the cache says, and wait for the answer ("Check now" in About). */
  check(running: string | null): Promise<UpdateStatus>;
}

export function createUpdateChecker(deps: UpdateCheckerDeps = {}): UpdateChecker {
  const lsRemote = deps.lsRemote ?? gitLsRemote;
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? CHECK_INTERVAL_MS;
  const waitMs = deps.waitMs ?? WAIT_MS;

  let remoteNewest: string | null = null;
  let checkedAt: number | null = null;
  let inFlight: Promise<void> | null = null;

  const refresh = (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = lsRemote()
      .then((out) => {
        remoteNewest = newestReleaseTag(out);
      })
      .catch(() => {
        // Offline, no `origin`, not a checkout: nothing to say until tomorrow.
      })
      .finally(() => {
        checkedAt = now();
        inFlight = null;
      });
    return inFlight;
  };

  const current = (running: string | null): UpdateStatus => ({
    latest: newerThan(running, remoteNewest),
    checkedAt: checkedAt === null ? null : new Date(checkedAt).toISOString(),
  });

  return {
    async status(running) {
      const stale = checkedAt === null || now() - checkedAt >= intervalMs;
      if (stale) {
        const pending = refresh();
        await Promise.race([pending, new Promise<void>((r) => setTimeout(r, waitMs).unref?.())]);
      }
      return current(running);
    },
    async check(running) {
      await refresh();
      return current(running);
    },
  };
}

/** A checker that never asks anyone: tests, and `updateCheck: false`. */
export const noUpdateChecker: UpdateChecker = {
  status: async () => ({ latest: null, checkedAt: null }),
  check: async () => ({ latest: null, checkedAt: null }),
};
