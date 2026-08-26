import {
  loadState,
  readMeta,
  readRepoConfig,
  readTeamConfigCache,
  listPrs,
  repoKeyOf,
  stateRoot,
  type Meta,
  type PrKey,
  type RepoConfig,
  type RepoKey,
  type TeamConfig,
  type TeamConfigCache,
} from "@reviewer/core";
import { configExists, readConfig, type ReviewerConfig } from "./config.js";

/**
 * Configuration layering.
 *
 * Four places can say something about how a PR is reviewed, and they are
 * ordered from most specific to most general:
 *
 *   1. PR meta          — `meta.json`, repoPath only (the per-PR override that
 *                         predates this file and keeps working);
 *   2. repo local       — `~/.purview/<host>/<owner>/<repo>/repo.json`, this
 *                         machine's settings for the whole repo;
 *   3. committed        — `.purview/config.json` in the target repo, the
 *                         team's shared defaults;
 *   4. global           — `~/.purview/config.json`, this machine's defaults;
 *   5. built-in default — what the app does with no configuration at all.
 *
 * `null`/absent at a level means "inherit", which is why `repo.json` fields are
 * nullable rather than optional-with-a-default: a repo has to be able to sit in
 * the middle of the chain without pinning a value.
 *
 * Everything here is pure disk reads — resolving a config must never make a
 * network call, so the committed layer is taken from the per-revision cache
 * (see team-config.ts, which is what fills it).
 */

export type ConfigSource = "pr" | "repo" | "committed" | "global" | "default";

export interface Resolved<T> {
  value: T;
  source: ConfigSource;
}

export interface EffectiveConfig {
  autoAnalyze: Resolved<boolean>;
  repoPath: Resolved<string | null>;
}

/** Every layer, already read. Injectable so callers can avoid re-reading. */
export interface ConfigLayers {
  meta?: Meta | null;
  local: RepoConfig;
  committed: TeamConfig | null;
  global: ReviewerConfig;
  globalIsExplicit: boolean;
}

export const BUILTIN_DEFAULTS = { autoAnalyze: true, repoPath: null } as const;

function isPrKey(key: PrKey | RepoKey): key is PrKey {
  return typeof (key as PrKey).number === "number";
}

/** The cached committed config for a PR's current revision, if any. */
export function cachedCommittedConfig(
  key: PrKey,
  root = stateRoot(),
): TeamConfigCache | null {
  try {
    const state = loadState(key, root);
    return readTeamConfigCache(key, state.currentRevision, root);
  } catch {
    return null;
  }
}

/**
 * The most recently fetched committed config anywhere in the repo. Used by the
 * repo-level views, which have no single PR to speak for the repo and must not
 * hit the network to find out.
 */
export function cachedCommittedConfigForRepo(
  repo: RepoKey,
  root = stateRoot(),
): TeamConfigCache | null {
  const prs = listPrs(root).filter(
    (k) => k.host === repo.host && k.owner === repo.owner && k.repo === repo.repo,
  );
  let best: TeamConfigCache | null = null;
  for (const pr of prs) {
    const cache = cachedCommittedConfig(pr, root);
    if (!cache) continue;
    if (!best || cache.fetchedAt > best.fetchedAt) best = cache;
  }
  return best;
}

export function readLayers(
  key: PrKey | RepoKey,
  root = stateRoot(),
  overrides: Partial<ConfigLayers> = {},
): ConfigLayers {
  const repo = isPrKey(key) ? repoKeyOf(key) : key;
  const meta =
    overrides.meta !== undefined
      ? overrides.meta
      : isPrKey(key)
        ? (() => {
            try {
              return readMeta(key, root);
            } catch {
              return null;
            }
          })()
        : null;
  const committed =
    overrides.committed !== undefined
      ? overrides.committed
      : ((isPrKey(key)
          ? cachedCommittedConfig(key, root)
          : cachedCommittedConfigForRepo(repo, root)
        )?.config ?? null);
  return {
    meta,
    local: overrides.local ?? readRepoConfig(repo, root),
    committed,
    global: overrides.global ?? readConfig(root),
    globalIsExplicit: overrides.globalIsExplicit ?? configExists(root),
  };
}

/**
 * The one resolver. Every consumer (auto-analysis triggers, repo path
 * resolution, the config endpoints) goes through this so the precedence is
 * stated exactly once.
 */
export function effectiveConfig(
  key: PrKey | RepoKey,
  root = stateRoot(),
  overrides: Partial<ConfigLayers> = {},
): EffectiveConfig {
  const layers = readLayers(key, root, overrides);

  const autoAnalyze: Resolved<boolean> =
    layers.local.autoAnalyze !== null
      ? { value: layers.local.autoAnalyze, source: "repo" }
      : layers.committed?.autoAnalyze !== undefined
        ? { value: layers.committed.autoAnalyze, source: "committed" }
        : layers.globalIsExplicit
          ? { value: layers.global.autoAnalyze, source: "global" }
          : { value: BUILTIN_DEFAULTS.autoAnalyze, source: "default" };

  const repoPath: Resolved<string | null> = layers.meta?.repoPath
    ? { value: layers.meta.repoPath, source: "pr" }
    : layers.local.repoPath
      ? { value: layers.local.repoPath, source: "repo" }
      : { value: BUILTIN_DEFAULTS.repoPath, source: "default" };

  return { autoAnalyze, repoPath };
}

/**
 * The checkout path to use for a PR: its own override first, then the repo's.
 * `undefined` (rather than null) because every consumer feeds it straight into
 * `resolveCheckout`, which speaks "no path configured" as undefined.
 */
export function effectiveRepoPath(
  key: PrKey,
  root = stateRoot(),
  overrides: Partial<ConfigLayers> = {},
): string | undefined {
  return effectiveConfig(key, root, overrides).repoPath.value ?? undefined;
}

/**
 * Whether an automatic analysis run may be triggered for this PR. Archived PRs
 * are excluded outright: they stay fully readable, but nothing about them is
 * allowed to spend money on its own.
 */
export function autoAnalyzeAllowed(
  key: PrKey,
  root = stateRoot(),
  overrides: Partial<ConfigLayers> = {},
): boolean {
  const layers = readLayers(key, root, overrides);
  if (layers.meta?.archived) return false;
  return effectiveConfig(key, root, layers).autoAnalyze.value;
}
