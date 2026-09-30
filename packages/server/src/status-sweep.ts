import {
  fetchPrStatuses,
  listPrs,
  readMeta,
  repoKeyToString,
  stateRoot,
  updateMeta,
  type Meta,
  type PrKey,
} from "@reviewer/core";
import { isRepoArchived } from "./repo-config.js";

/**
 * Keeps every tracked PR's open/draft/merged/closed state, review decision,
 * title and description current, whether or not anyone has its page open. The
 * staleness check does the same for one PR while its page is up; this is the
 * background twin for the rest, run on the review watcher's tick.
 *
 * One GraphQL query per repo (see `fetchPrStatuses`), so the cost grows with
 * repos, not PRs. Skipped: archived PRs and repos (on the shelf, nobody is
 * looking) and merged PRs (terminal). Closed PRs stay in, since they can be
 * reopened. Only meta is written — revisions and hunks are `refreshPr`'s job.
 */

export interface SweepResult {
  /** PRs whose meta changed. */
  updated: string[];
  /** Per repo, what went wrong; the other repos are still swept. */
  errors: Record<string, string>;
}

/** Which PRs a sweep asks about, grouped by repo. */
export function sweepTargets(root = stateRoot()): Map<string, PrKey[]> {
  const byRepo = new Map<string, PrKey[]>();
  const archivedRepo = new Map<string, boolean>();
  for (const key of listPrs(root)) {
    const rkey = repoKeyToString(key);
    if (!archivedRepo.has(rkey)) archivedRepo.set(rkey, safeRepoArchived(key, root));
    if (archivedRepo.get(rkey)) continue;
    let meta: Meta;
    try {
      meta = readMeta(key, root);
    } catch {
      continue;
    }
    if (meta.archived || meta.prState === "merged") continue;
    const list = byRepo.get(rkey) ?? [];
    list.push(key);
    byRepo.set(rkey, list);
  }
  return byRepo;
}

function safeRepoArchived(key: PrKey, root: string): boolean {
  try {
    return isRepoArchived(key, root);
  } catch {
    return false;
  }
}

/**
 * The meta patch for one PR, or null when nothing moved. A `null` upstream
 * decision is "unknown", never "cleared" — same rule as the staleness check,
 * since GitHub hosts that lack the field would otherwise wipe real ones.
 */
export function statusPatch(
  meta: Pick<Meta, "prState" | "reviewDecision" | "title" | "body">,
  upstream: {
    prState: Meta["prState"];
    reviewDecision: Meta["reviewDecision"];
    title: string;
    body?: string;
  },
): Partial<Meta> | null {
  const patch: Partial<Meta> = {};
  if (upstream.prState && upstream.prState !== meta.prState) patch.prState = upstream.prState;
  if (upstream.reviewDecision && upstream.reviewDecision !== meta.reviewDecision) {
    patch.reviewDecision = upstream.reviewDecision;
  }
  if (upstream.title && upstream.title !== meta.title) patch.title = upstream.title;
  // "" is a real value (the author cleared it); only an absent one is unknown.
  if (upstream.body !== undefined && upstream.body !== meta.body) patch.body = upstream.body;
  return Object.keys(patch).length ? patch : null;
}

export async function sweepPrStatuses(root = stateRoot()): Promise<SweepResult> {
  const result: SweepResult = { updated: [], errors: {} };
  for (const [rkey, keys] of sweepTargets(root)) {
    try {
      const statuses = await fetchPrStatuses(
        keys[0],
        keys.map((k) => k.number),
      );
      for (const key of keys) {
        const upstream = statuses.get(key.number);
        if (!upstream) continue;
        const patch = statusPatch(readMeta(key, root), upstream);
        if (!patch) continue;
        updateMeta(key, patch, root);
        result.updated.push(`${rkey}#${key.number}`);
      }
    } catch (err) {
      result.errors[rkey] = (err as Error).message;
      console.warn(`[watch] ${rkey}: status sweep failed: ${(err as Error).message}`);
    }
  }
  return result;
}
