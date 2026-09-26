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
  type AgentSelection,
  type ChatAgentSelection,
} from "@reviewer/core";
import { configExists, readConfig, type ReviewerConfig } from "./config.js";
import { DEFAULT_HARNESS, findHarness, harnessIds } from "./agent/registry.js";
import type { HarnessId } from "./agent/types.js";
import { HttpError } from "./http-error.js";

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

/** `chat`: a conversation's own pin (chat.json), more specific than any layer. */
export type ConfigSource = "chat" | "pr" | "repo" | "committed" | "global" | "default";

export interface Resolved<T> {
  value: T;
  source: ConfigSource;
}

/**
 * Which harness runs a kind of work, with which of its models (and, for
 * analysis, effort). Each part says where it came from.
 */
export interface ResolvedAgent {
  harness: Resolved<HarnessId>;
  model: Resolved<string>;
  /** analysis only; "none" means "set no effort" */
  effort?: Resolved<string>;
  /**
   * Why this selection cannot run: a harness this server does not have, or a
   * model/effort the harness does not offer. Never papered over with a
   * default — a different harness or model can mean a different bill.
   */
  problem?: string;
}

export interface EffectiveConfig {
  autoAnalyze: Resolved<boolean>;
  repoPath: Resolved<string | null>;
  /** who runs automated/manual analyses */
  analysisAgent: ResolvedAgent;
  /** who answers review-chat turns (and re-anchors comments), before a chat's own pin */
  chatAgent: ResolvedAgent;
}

/** Every layer, already read. Injectable so callers can avoid re-reading. */
export interface ConfigLayers {
  meta?: Meta | null;
  local: RepoConfig;
  committed: TeamConfig | null;
  global: ReviewerConfig;
  globalIsExplicit: boolean;
}

/**
 * What the app does with no configuration at all. Agent defaults are not
 * here: an unset model or effort resolves to its harness's own manifest
 * defaults (see `resolveAgent`).
 */
export const BUILTIN_DEFAULTS = {
  autoAnalyze: true,
  repoPath: null,
} as const satisfies {
  autoAnalyze: boolean;
  repoPath: string | null;
};

const SOURCE_NAMES: Record<ConfigSource, string> = {
  chat: "this chat's own setting",
  pr: "this PR's settings",
  repo: "the repo settings",
  committed: "the repo's committed .purview/config.json",
  global: "the global settings",
  default: "the built-in default",
};

/**
 * One agent, layer by layer, most specific first. The harness is the first
 * one any layer names. A model or effort only counts from a layer that names
 * that same harness: a Claude model set globally means nothing to a repo that
 * switched to another harness, which gets that harness's defaults instead.
 */
export function resolveAgent(
  label: string,
  candidates: [ConfigSource, AgentSelection | ChatAgentSelection | null | undefined][],
  withEffort: boolean,
): ResolvedAgent {
  const named = candidates.find(([, sel]) => sel);
  const harness: Resolved<HarnessId> = named
    ? { value: named[1]!.harness, source: named[0] }
    : { value: DEFAULT_HARNESS, source: "default" };
  const same = candidates.filter(([, sel]) => sel?.harness === harness.value);
  const found = findHarness(harness.value);
  const problems: string[] = [];
  if (!found) {
    problems.push(
      `The ${label} agent "${harness.value}" (from ${SOURCE_NAMES[harness.source]}) is not available here; ` +
        `available: ${harnessIds().join(", ")}.`,
    );
  }

  const pick = (field: "model" | "effort", fallback: string | undefined, allowed: string[] | undefined) => {
    const hit = same.find(([, sel]) => (sel as AgentSelection)[field] !== undefined);
    const resolved: Resolved<string> = hit
      ? { value: (hit[1] as AgentSelection)[field]!, source: hit[0] }
      : { value: fallback ?? "", source: "default" };
    if (found && hit && allowed && !allowed.includes(resolved.value)) {
      problems.push(
        `${found.manifest.name} has no ${field} "${resolved.value}" (from ${SOURCE_NAMES[resolved.source]}); ` +
          `it has ${allowed.join(", ")}.`,
      );
    }
    return resolved;
  };

  const model = pick("model", found?.manifest.defaults.model, found?.manifest.models.map((m) => m.id));
  const effort = withEffort ? pick("effort", found?.manifest.defaults.effort, found?.manifest.efforts) : undefined;
  return {
    harness,
    model,
    ...(effort ? { effort } : {}),
    ...(problems.length ? { problem: problems.join(" ") } : {}),
  };
}

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

  return {
    autoAnalyze,
    repoPath,
    analysisAgent: resolveAgent(
      "analysis",
      [
        ["repo", layers.local.analysisAgent],
        ["committed", layers.committed?.analysisAgent],
        ["global", layers.global.analysisAgent],
      ],
      true,
    ),
    chatAgent: resolveAgent(
      "chat",
      [
        ["repo", layers.local.chatAgent],
        ["committed", layers.committed?.chatAgent],
        ["global", layers.global.chatAgent],
      ],
      false,
    ),
  };
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
 * Whether the whole repo is archived (`repo.json`'s `archived`). Not layered:
 * it is this machine's shelf, so the raw local value is the whole story.
 */
export function isRepoArchived(repo: RepoKey, root = stateRoot()): boolean {
  return readRepoConfig(repo, root).archived === true;
}

/**
 * Where a PR's archived state comes from: its own `meta.archived` (`"pr"`),
 * its repo's (`"repo"`), or nowhere (`null`). The PR's own flag wins a tie so
 * that unarchiving the repo is never shown as the way to unarchive a PR that
 * would stay archived on its own.
 */
export function archiveSource(
  key: PrKey,
  root = stateRoot(),
  overrides: Pick<Partial<ConfigLayers>, "meta" | "local"> = {},
): "pr" | "repo" | null {
  const meta =
    overrides.meta !== undefined
      ? overrides.meta
      : (() => {
          try {
            return readMeta(key, root);
          } catch {
            return null;
          }
        })();
  if (meta?.archived) return "pr";
  const local = overrides.local ?? readRepoConfig(repoKeyOf(key), root);
  return local.archived === true ? "repo" : null;
}

/**
 * The one question every archive gate asks: does this PR behave as archived,
 * either on its own or because its whole repo is? Everything that `meta.archived`
 * used to gate on its own (automatic analysis, background review-request
 * lookups, managed checkouts) goes through this, so a repo-level archive is
 * honoured everywhere without flipping any PR's own flag.
 */
export function isEffectivelyArchived(
  key: PrKey,
  root = stateRoot(),
  overrides: Pick<Partial<ConfigLayers>, "meta" | "local"> = {},
): boolean {
  return archiveSource(key, root, overrides) !== null;
}

/**
 * Whether an automatic analysis run may be triggered for this PR. Archived PRs
 * (on their own or through their repo) are excluded outright: they stay fully
 * readable, but nothing about them is allowed to spend money on its own.
 */
export function autoAnalyzeAllowed(
  key: PrKey,
  root = stateRoot(),
  overrides: Partial<ConfigLayers> = {},
): boolean {
  return autoAnalyzeBlocker(key, root, overrides) === null;
}

/**
 * Why an automatic run would not start for this PR, or `null` when it would.
 * `"disabled"` wins over `"archived"`: when the layers say no, archiving the
 * PR is not what held the run back, so it would be wrong to say so.
 */
export function autoAnalyzeBlocker(
  key: PrKey,
  root = stateRoot(),
  overrides: Partial<ConfigLayers> = {},
): "archived" | "disabled" | null {
  const layers = readLayers(key, root, overrides);
  if (!effectiveConfig(key, root, layers).autoAnalyze.value) return "disabled";
  if (isEffectivelyArchived(key, root, layers)) return "archived";
  return null;
}

/** What a run is spawned with: a harness that exists, and a model (and effort) it has. */
export interface AgentChoice {
  harness: HarnessId;
  model: string;
  effort?: string;
}

function runnable(agent: ResolvedAgent): AgentChoice {
  if (agent.problem) throw new HttpError(400, "invalid_agent_config", agent.problem);
  return {
    harness: agent.harness.value,
    model: agent.model.value,
    ...(agent.effort ? { effort: agent.effort.value } : {}),
  };
}

/** Who runs an analysis for this PR (or repo). Throws a 400 when the configuration cannot run. */
export function effectiveAnalysisAgent(
  key: PrKey | RepoKey,
  root = stateRoot(),
  overrides: Partial<ConfigLayers> = {},
): AgentChoice {
  return runnable(effectiveConfig(key, root, overrides).analysisAgent);
}

/**
 * The chat's agent as the layers resolve it, with a conversation's own pin
 * (chat.json) as the most specific layer.
 */
export function resolveChatAgent(
  key: PrKey | RepoKey,
  root = stateRoot(),
  overrides: Partial<ConfigLayers> = {},
  pin: ChatAgentSelection | null = null,
): ResolvedAgent {
  const layers = readLayers(key, root, overrides);
  return resolveAgent(
    "chat",
    [
      ["chat", pin],
      ["repo", layers.local.chatAgent],
      ["committed", layers.committed?.chatAgent],
      ["global", layers.global.chatAgent],
    ],
    false,
  );
}

/** Who answers a chat turn (or re-anchors a comment). Throws a 400 when the configuration cannot run. */
export function effectiveChatAgent(
  key: PrKey | RepoKey,
  root = stateRoot(),
  overrides: Partial<ConfigLayers> = {},
  pin: ChatAgentSelection | null = null,
): AgentChoice {
  return runnable(resolveChatAgent(key, root, overrides, pin));
}

/* ------------------------------------------------ flat API compatibility */

/**
 * The settings API still speaks the flat `analysisModel`/`analysisEffort`/
 * `chatModel` fields its clients know; these translate between them and a
 * layer's selections. A flat edit applies to the layer's own harness, or the
 * effective one when the layer names none.
 */
export function flatAgentFields(
  analysis: AgentSelection | null | undefined,
  chat: ChatAgentSelection | null | undefined,
): { analysisModel: string | null; analysisEffort: string | null; chatModel: string | null } {
  return {
    analysisModel: analysis?.model ?? null,
    analysisEffort: analysis?.effort ?? null,
    chatModel: chat?.model ?? null,
  };
}

/**
 * One flat field edit applied to a selection. `null` clears the field; a
 * selection left with neither model nor effort is `null` again (inherit).
 * Values are checked against the harness's manifest — a 400 names the
 * choices, rather than storing something no run could use.
 */
export function patchAgentSelection<T extends AgentSelection | ChatAgentSelection>(
  current: T | null,
  field: "model" | "effort",
  value: string | null,
  fallbackHarness: HarnessId,
  apiField: string,
): T | null {
  const harnessId = current?.harness ?? fallbackHarness;
  const harness = findHarness(harnessId);
  if (value !== null) {
    if (!harness) throw new HttpError(400, "invalid_body", `${apiField}: agent harness "${harnessId}" is not available`);
    const allowed = field === "model" ? harness.manifest.models.map((m) => m.id) : harness.manifest.efforts;
    if (!allowed.includes(value)) {
      throw new HttpError(
        400,
        "invalid_body",
        `${apiField}: "${value}" is not one of ${harness.manifest.name}'s ${field === "model" ? "models" : "effort levels"}: ${allowed.join(", ")}`,
      );
    }
  }
  const next: Record<string, string> = { ...(current ?? {}), harness: harnessId };
  if (value === null) delete next[field];
  else next[field] = value;
  return next.model === undefined && next.effort === undefined ? null : (next as unknown as T);
}
