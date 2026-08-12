import { homedir } from "node:os";
import path from "node:path";

export interface PrKey {
  host: string;
  owner: string;
  repo: string;
  number: number;
}

/** Root of all state. Overridable with REVIEWER_STATE_DIR (tests, server). */
export function stateRoot(): string {
  const override = process.env.REVIEWER_STATE_DIR;
  return override && override.length > 0
    ? path.resolve(override)
    : path.join(homedir(), ".reviewer");
}

/** `~/.reviewer/<host>/<owner>/<repo>/<number>/` */
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

export function migrationReportPath(
  key: PrKey,
  revision: number,
  root = stateRoot(),
): string {
  return path.join(revisionDir(key, revision, root), "migration.json");
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
