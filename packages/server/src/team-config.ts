import fs from "node:fs";
import path from "node:path";
import {
  TeamConfigSchema,
  fetchRepoFile,
  keyToString,
  loadState,
  readTeamConfigCache,
  writeTeamConfigCache,
  stateRoot,
  type PrKey,
  type TeamConfig,
  type TeamConfigCache,
} from "@reviewer/core";
import { effectiveRepoPath } from "./repo-config.js";
import { prHead } from "./repo-path.js";
import { resolveCheckout } from "./worktree.js";

/**
 * The team's configuration, committed in the *target* repo under `.purview/`:
 *
 *   .purview/config.json   { "autoAnalyze": true }   (unknown keys ignored)
 *   .purview/RUBRIC.md     markdown, refines the built-in rubric
 *   .purview/CHAT.md       markdown, refines the review-chat system prompt
 *
 * Two ways to read it, in this order:
 *   1. the resolved local checkout, when there is one — free, and already the
 *      right revision when the worktree holds the PR's branch;
 *   2. `gh api repos/{o}/{r}/contents/.purview/...` at the PR's head sha.
 *
 * The result is cached in the revision directory (`team-config.json`), keyed by
 * head sha, so it costs one fetch per revision rather than one per prompt. A
 * refresh creates a new revision, which is what re-reads it; `{refresh: true}`
 * forces a re-read within the same revision.
 *
 * Nothing here is allowed to fail a caller: an unreachable API, a malformed
 * config, a repo with no `.purview/` at all — all of them are just "no
 * committed config".
 */

export const TEAM_CONFIG_FILE = ".purview/config.json";
export const TEAM_RUBRIC_FILE = ".purview/RUBRIC.md";
export const TEAM_CHAT_FILE = ".purview/CHAT.md";

export interface CommittedConfig {
  present: boolean;
  config: TeamConfig | null;
  rubric: string | null;
  chatInstructions: string | null;
  source: "checkout" | "github" | "none";
  ref: string;
}

const NONE: CommittedConfig = {
  present: false,
  config: null,
  rubric: null,
  chatInstructions: null,
  source: "none",
  ref: "",
};

function parseTeamConfig(raw: string | null): TeamConfig | null {
  if (raw === null) return null;
  try {
    const parsed = TeamConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function readFromCheckout(
  dir: string,
): { config: string | null; rubric: string | null; chatInstructions: string | null } {
  const read = (rel: string): string | null => {
    const file = path.join(dir, rel);
    try {
      return fs.statSync(file).isFile() ? fs.readFileSync(file, "utf8") : null;
    } catch {
      return null;
    }
  };
  return {
    config: read(TEAM_CONFIG_FILE),
    rubric: read(TEAM_RUBRIC_FILE),
    chatInstructions: read(TEAM_CHAT_FILE),
  };
}

function toResult(cache: TeamConfigCache): CommittedConfig {
  return {
    present: cache.present,
    config: cache.config,
    rubric: cache.rubric,
    chatInstructions: cache.chatInstructions,
    source: cache.source,
    ref: cache.ref,
  };
}

/** The cached committed config only — never reads a checkout or the network. */
export function cachedCommitted(key: PrKey, root = stateRoot()): CommittedConfig {
  try {
    const state = loadState(key, root);
    const cache = readTeamConfigCache(key, state.currentRevision, root);
    return cache ? toResult(cache) : NONE;
  } catch {
    return NONE;
  }
}

export function loadCommittedConfig(
  key: PrKey,
  root = stateRoot(),
  opts: { refresh?: boolean } = {},
): CommittedConfig {
  let revision: number;
  let headSha: string | undefined;
  try {
    const state = loadState(key, root);
    revision = state.currentRevision;
    headSha = state.revisions.find((r) => r.revision === revision)?.headSha;
  } catch {
    return NONE;
  }
  if (revision <= 0) return NONE;

  const ref = headSha ?? "";
  const cached = readTeamConfigCache(key, revision, root);
  if (cached && cached.ref === ref && !opts.refresh) return toResult(cached);

  let source: CommittedConfig["source"] = "none";
  let rawConfig: string | null = null;
  let rubric: string | null = null;
  let chatInstructions: string | null = null;

  const checkout = resolveCheckout(effectiveRepoPath(key, root), prHead(key, root));
  if (checkout.path) {
    const fromDisk = readFromCheckout(checkout.path);
    if (fromDisk.config !== null || fromDisk.rubric !== null || fromDisk.chatInstructions !== null) {
      source = "checkout";
      rawConfig = fromDisk.config;
      rubric = fromDisk.rubric;
      chatInstructions = fromDisk.chatInstructions;
    }
  }

  if (source === "none") {
    try {
      rawConfig = fetchRepoFile(key, TEAM_CONFIG_FILE, headSha);
      rubric = fetchRepoFile(key, TEAM_RUBRIC_FILE, headSha);
      chatInstructions = fetchRepoFile(key, TEAM_CHAT_FILE, headSha);
      if (rawConfig !== null || rubric !== null || chatInstructions !== null) source = "github";
    } catch (err) {
      // Reading the team config is an enhancement; never let it break a run.
      console.warn(
        `[team-config] ${keyToString(key)}: could not read ${TEAM_CONFIG_FILE}: ${
          (err as Error).message
        }`,
      );
    }
  }

  const config = parseTeamConfig(rawConfig);
  const cache: TeamConfigCache = {
    ref,
    fetchedAt: new Date().toISOString(),
    source,
    present: source !== "none",
    config,
    rubric,
    chatInstructions,
  };
  try {
    writeTeamConfigCache(key, revision, cache, root);
  } catch {
    // A read-only state dir shouldn't stop us from using what we just read.
  }
  return toResult(cache);
}
