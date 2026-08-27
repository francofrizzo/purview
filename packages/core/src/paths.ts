import { homedir } from "node:os";
import path from "node:path";

export interface PrKey {
  host: string;
  owner: string;
  repo: string;
  number: number;
}

/** A repository, without a PR number: the level per-repo settings live at. */
export interface RepoKey {
  host: string;
  owner: string;
  repo: string;
}

/** Directory name of the state root inside `$HOME`. */
export const STATE_DIR_NAME = ".purview";
/** The pre-rename name; migrated away from on startup (see migrateStateDir). */
export const LEGACY_STATE_DIR_NAME = ".reviewer";

/**
 * Root of all state. Overridable with `PURVIEW_STATE_DIR`; `REVIEWER_STATE_DIR`
 * is kept as a legacy alias so existing setups (and older tests) keep working.
 */
export function stateRoot(): string {
  const override =
    process.env.PURVIEW_STATE_DIR || process.env.REVIEWER_STATE_DIR;
  return override && override.length > 0
    ? path.resolve(override)
    : path.join(homedir(), STATE_DIR_NAME);
}

/** `~/.reviewer` — where state lived before the rename. */
export function legacyStateRoot(): string {
  return path.join(homedir(), LEGACY_STATE_DIR_NAME);
}

/** True when the root is the default one (i.e. no env override is in play). */
export function stateRootIsDefault(): boolean {
  return !(process.env.PURVIEW_STATE_DIR || process.env.REVIEWER_STATE_DIR);
}

/**
 * `~/.purview/config.json` — machine-wide app settings (onboarding result,
 * auto-analysis consent, extra dev origins). Lives beside the per-PR trees, not
 * inside one, so it survives deleting any single PR's state.
 */
export function configPath(root = stateRoot()): string {
  return path.join(root, "config.json");
}

/** `~/.purview/<host>/<owner>/<repo>/` — per-repo settings + the PR dirs. */
export function repoDir(key: RepoKey, root = stateRoot()): string {
  return path.join(root, key.host, key.owner, key.repo);
}

/**
 * Files that live in a repo dir *beside* the numbered PR directories.
 * PR directories are always `String(number)`, i.e. digits only, so no PR can
 * ever collide with one of these names — `isPrDirName` enforces that.
 */
export const REPO_FILE_NAMES = ["repo.json", "RUBRIC.local.md", "CHAT.local.md"] as const;

/** `~/.purview/<host>/<owner>/<repo>/repo.json` */
export function repoConfigPath(key: RepoKey, root = stateRoot()): string {
  return path.join(repoDir(key, root), "repo.json");
}

/** `~/.purview/<host>/<owner>/<repo>/RUBRIC.local.md` (may be absent) */
export function repoRubricPath(key: RepoKey, root = stateRoot()): string {
  return path.join(repoDir(key, root), "RUBRIC.local.md");
}

/** `~/.purview/<host>/<owner>/<repo>/CHAT.local.md` (may be absent) */
export function repoChatInstructionsPath(key: RepoKey, root = stateRoot()): string {
  return path.join(repoDir(key, root), "CHAT.local.md");
}

/**
 * Only digit runs name a PR directory. Everything else in a repo dir (repo
 * config, local rubric, anything a future version adds) is skipped by the PR
 * walker, so repo-level files and PR dirs can never be confused.
 */
export function isPrDirName(name: string): boolean {
  return /^[0-9]+$/.test(name);
}

/** `~/.purview/<host>/<owner>/<repo>/<number>/` */
export function prDir(key: PrKey, root = stateRoot()): string {
  return path.join(root, key.host, key.owner, key.repo, String(key.number));
}

export function metaPath(key: PrKey, root = stateRoot()): string {
  return path.join(prDir(key, root), "meta.json");
}

export function eventsPath(key: PrKey, root = stateRoot()): string {
  return path.join(prDir(key, root), "events.jsonl");
}

export function statePath(key: PrKey, root = stateRoot()): string {
  return path.join(prDir(key, root), "state.json");
}

/** Persisted record of the latest Claude analysis run for this PR. */
export function analysisJobPath(key: PrKey, root = stateRoot()): string {
  return path.join(prDir(key, root), "analysis-job.json");
}

/** Chat session id + transcript summary for the review-assistant chat. */
export function chatPath(key: PrKey, root = stateRoot()): string {
  return path.join(prDir(key, root), "chat.json");
}

export function revisionDir(
  key: PrKey,
  revision: number,
  root = stateRoot(),
): string {
  return path.join(prDir(key, root), "revisions", String(revision));
}

export function diffPath(
  key: PrKey,
  revision: number,
  root = stateRoot(),
): string {
  return path.join(revisionDir(key, revision, root), "diff.patch");
}

export function filesJsonPath(
  key: PrKey,
  revision: number,
  root = stateRoot(),
): string {
  return path.join(revisionDir(key, revision, root), "files.json");
}

/**
 * Cached read of the target repo's committed `.purview/` config for one
 * revision. Cached per revision because it is keyed by the head sha: a new
 * revision means a possibly different committed config.
 */
export function teamConfigPath(
  key: PrKey,
  revision: number,
  root = stateRoot(),
): string {
  return path.join(revisionDir(key, revision, root), "team-config.json");
}

export function migrationReportPath(
  key: PrKey,
  revision: number,
  root = stateRoot(),
): string {
  return path.join(revisionDir(key, revision, root), "migration.json");
}

/** Canonical string key: `host/owner/repo`. */
export function repoKeyToString(key: RepoKey): string {
  return `${key.host}/${key.owner}/${key.repo}`;
}

/** Accepts `host/owner/repo` or `owner/repo` (github.com implied). */
export function parseRepoKey(input: string): RepoKey {
  const decoded = decodeURIComponent(input.trim());
  const parts = decoded.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length === 3) {
    return { host: parts[0], owner: parts[1], repo: parts[2] };
  }
  if (parts.length === 2) {
    return { host: "github.com", owner: parts[0], repo: parts[1] };
  }
  throw new Error(
    `Invalid repo key "${input}" (expected host/owner/repo or owner/repo)`,
  );
}

/** The repo a PR belongs to. */
export function repoKeyOf(key: PrKey): RepoKey {
  return { host: key.host, owner: key.owner, repo: key.repo };
}

/** Canonical string key: `host/owner/repo/number`. */
export function keyToString(key: PrKey): string {
  return `${key.host}/${key.owner}/${key.repo}/${key.number}`;
}

/**
 * Accepts `host/owner/repo/number`, `owner/repo/number` (github.com implied),
 * or a full PR URL.
 */
export function parseKey(input: string): PrKey {
  const decoded = decodeURIComponent(input.trim());
  if (/^https?:\/\//.test(decoded)) return parsePrUrl(decoded);
  const parts = decoded.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length === 4) {
    return {
      host: parts[0],
      owner: parts[1],
      repo: parts[2],
      number: Number(parts[3]),
    };
  }
  if (parts.length === 3) {
    return {
      host: "github.com",
      owner: parts[0],
      repo: parts[1],
      number: Number(parts[2]),
    };
  }
  throw new Error(
    `Invalid PR key "${input}" (expected host/owner/repo/number or a PR URL)`,
  );
}

/** `https://github.com/owner/repo/pull/123` -> PrKey */
export function parsePrUrl(url: string): PrKey {
  const m = url
    .trim()
    .match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull(?:s)?\/(\d+)/);
  if (!m) throw new Error(`Not a pull request URL: ${url}`);
  return {
    host: m[1],
    owner: m[2],
    repo: m[3],
    number: Number(m[4]),
  };
}
