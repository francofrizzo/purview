import fs from "node:fs";
import path from "node:path";
import {
  ClaudeModelSchema,
  EMPTY_REPO_CONFIG,
  EventSchema,
  FilesJsonSchema,
  MetaSchema,
  MigrationReportSchema,
  RepoConfigSchema,
  StateSchema,
  TeamConfigCacheSchema,
} from "./schemas.js";
import type {
  FileDiff,
  FilesJson,
  Meta,
  MigrationReport,
  NewEvent,
  RepoConfig,
  ReviewerEvent,
  State,
  TeamConfigCache,
} from "./schemas.js";
import { fold } from "./reducer.js";
import {
  diffPath,
  eventsPath,
  filesJsonPath,
  isPrDirName,
  metaPath,
  migrationReportPath,
  prDir,
  repoConfigPath,
  repoDir,
  repoRubricPath,
  revisionDir,
  statePath,
  stateRoot,
  teamConfigPath,
  type PrKey,
  type RepoKey,
} from "./paths.js";

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export function prExists(key: PrKey, root = stateRoot()): boolean {
  return fs.existsSync(metaPath(key, root));
}

export function writeMeta(key: PrKey, meta: Meta, root = stateRoot()): void {
  writeJson(metaPath(key, root), MetaSchema.parse(meta));
}

export function readMeta(key: PrKey, root = stateRoot()): Meta {
  const file = metaPath(key, root);
  if (!fs.existsSync(file)) throw new Error(`No PR state at ${prDir(key, root)}`);
  return MetaSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}

/**
 * Merge fields into meta.json (currently only `repoPath` moves after init).
 * Read-modify-write rather than a blind overwrite so a caller setting one
 * field can't drop the rest.
 */
export function updateMeta(
  key: PrKey,
  patch: Partial<Meta>,
  root = stateRoot(),
): Meta {
  const merged = MetaSchema.parse({ ...readMeta(key, root), ...patch });
  writeJson(metaPath(key, root), merged);
  return merged;
}

export function readEvents(key: PrKey, root = stateRoot()): ReviewerEvent[] {
  const file = eventsPath(key, root);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l, i) => {
      try {
        return EventSchema.parse(JSON.parse(l));
      } catch (err) {
        throw new Error(
          `events.jsonl line ${i + 1} is invalid: ${(err as Error).message}`,
        );
      }
    });
}

/** Append one event and refresh the derived state.json snapshot. */
export function appendEvent(
  key: PrKey,
  event: NewEvent,
  root = stateRoot(),
): State {
  return appendEvents(key, [event], root);
}

export function appendEvents(
  key: PrKey,
  events: NewEvent[],
  root = stateRoot(),
): State {
  const file = eventsPath(key, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ts = new Date().toISOString();
  const lines = events
    .map((e) => EventSchema.parse({ ts, ...e } as ReviewerEvent))
    .map((e) => JSON.stringify(e))
    .join("\n");
  fs.appendFileSync(file, lines + "\n", "utf8");
  return rebuildState(key, root);
}

/** state.json is derived: always foldable from events.jsonl alone. */
export function rebuildState(key: PrKey, root = stateRoot()): State {
  const state = fold(readEvents(key, root));
  writeJson(statePath(key, root), state);
  return state;
}

/** Reads the snapshot if present, otherwise rebuilds it from the event log. */
export function loadState(key: PrKey, root = stateRoot()): State {
  const file = statePath(key, root);
  if (!fs.existsSync(file)) return rebuildState(key, root);
  try {
    return StateSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return rebuildState(key, root);
  }
}

export function writeRevision(
  key: PrKey,
  revision: number,
  patch: string,
  files: FileDiff[],
  shas: { baseSha?: string; headSha?: string; mergeBase?: string } = {},
  root = stateRoot(),
): FilesJson {
  fs.mkdirSync(revisionDir(key, revision, root), { recursive: true });
  fs.writeFileSync(diffPath(key, revision, root), patch, "utf8");
  const filesJson = FilesJsonSchema.parse({ revision, files, ...shas });
  writeJson(filesJsonPath(key, revision, root), filesJson);
  return filesJson;
}

export function readFilesJson(
  key: PrKey,
  revision: number,
  root = stateRoot(),
): FilesJson {
  const file = filesJsonPath(key, revision, root);
  if (!fs.existsSync(file))
    throw new Error(`No files.json for revision ${revision}`);
  return FilesJsonSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}

export function readDiff(
  key: PrKey,
  revision: number,
  root = stateRoot(),
): string {
  return fs.readFileSync(diffPath(key, revision, root), "utf8");
}

export function writeMigrationReport(
  key: PrKey,
  report: MigrationReport,
  root = stateRoot(),
): void {
  writeJson(
    migrationReportPath(key, report.revision, root),
    MigrationReportSchema.parse(report),
  );
}

export function readMigrationReport(
  key: PrKey,
  revision: number,
  root = stateRoot(),
): MigrationReport | undefined {
  const file = migrationReportPath(key, revision, root);
  if (!fs.existsSync(file)) return undefined;
  return MigrationReportSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}

/** Every PR that has state on disk. */
export function listPrs(root = stateRoot()): PrKey[] {
  const out: PrKey[] = [];
  if (!fs.existsSync(root)) return out;
  const dirs = (p: string) =>
    fs
      .readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  for (const host of dirs(root)) {
    for (const owner of dirs(path.join(root, host))) {
      for (const repo of dirs(path.join(root, host, owner))) {
        for (const number of dirs(path.join(root, host, owner, repo))) {
          // Repo-level files (repo.json, RUBRIC.local.md) live in this same
          // directory; only digit-named entries can be PRs.
          if (!isPrDirName(number)) continue;
          const key = { host, owner, repo, number: Number(number) };
          if (Number.isFinite(key.number) && prExists(key, root)) out.push(key);
        }
      }
    }
  }
  return out;
}

/* --------------------------------------------------------- repo-level state */

export function repoConfigExists(key: RepoKey, root = stateRoot()): boolean {
  return fs.existsSync(repoConfigPath(key, root));
}

/**
 * Read `repo.json`, tolerantly: a missing file, unparseable JSON, or a single
 * field of the wrong type must never take the app down — the field falls back
 * to `null` ("inherit") and everything else in the file is kept.
 */
export function readRepoConfig(key: RepoKey, root = stateRoot()): RepoConfig {
  const file = repoConfigPath(key, root);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { ...EMPTY_REPO_CONFIG };
  }
  const parsed = RepoConfigSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // Salvage what is valid rather than discarding the whole file.
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const model = (v: unknown) =>
    ClaudeModelSchema.safeParse(v).data ?? null;
  return {
    autoAnalyze: typeof obj.autoAnalyze === "boolean" ? obj.autoAnalyze : null,
    repoPath: typeof obj.repoPath === "string" ? obj.repoPath : null,
    analysisModel: model(obj.analysisModel),
    chatModel: model(obj.chatModel),
  };
}

export function writeRepoConfig(
  key: RepoKey,
  patch: Partial<RepoConfig>,
  root = stateRoot(),
): RepoConfig {
  const next = RepoConfigSchema.parse({
    ...(repoConfigExists(key, root) ? readRepoConfig(key, root) : {}),
    ...patch,
  });
  writeJson(repoConfigPath(key, root), next);
  return next;
}

/**
 * Create an all-null `repo.json` if the repo has none yet. Called when the
 * first PR of a repo is initialized, so the file is there to be discovered
 * (and edited) rather than materializing only once something is set.
 */
export function ensureRepoConfig(key: RepoKey, root = stateRoot()): RepoConfig {
  if (repoConfigExists(key, root)) return readRepoConfig(key, root);
  return writeRepoConfig(key, {}, root);
}

/** `RUBRIC.local.md`, or "" when there is none. */
export function readLocalRubric(key: RepoKey, root = stateRoot()): string {
  const file = repoRubricPath(key, root);
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Writing an empty rubric deletes the file: absent and empty are one state. */
export function writeLocalRubric(
  key: RepoKey,
  content: string,
  root = stateRoot(),
): void {
  const file = repoRubricPath(key, root);
  if (content.trim() === "") {
    if (fs.existsSync(file)) fs.rmSync(file);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

/** Every repo that has state on disk (a PR dir or a repo.json of its own). */
export function listRepos(root = stateRoot()): RepoKey[] {
  const out: RepoKey[] = [];
  if (!fs.existsSync(root)) return out;
  const dirs = (p: string) =>
    fs
      .readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  for (const host of dirs(root)) {
    for (const owner of dirs(path.join(root, host))) {
      for (const repo of dirs(path.join(root, host, owner))) {
        const key = { host, owner, repo };
        const hasPr = dirs(repoDir(key, root)).some(
          (n) => isPrDirName(n) && prExists({ ...key, number: Number(n) }, root),
        );
        if (hasPr || repoConfigExists(key, root)) out.push(key);
      }
    }
  }
  return out;
}

/* ------------------------------------------- committed team-config cache */

export function readTeamConfigCache(
  key: PrKey,
  revision: number,
  root = stateRoot(),
): TeamConfigCache | null {
  const file = teamConfigPath(key, revision, root);
  if (!fs.existsSync(file)) return null;
  try {
    return TeamConfigCacheSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

export function writeTeamConfigCache(
  key: PrKey,
  revision: number,
  cache: TeamConfigCache,
  root = stateRoot(),
): TeamConfigCache {
  const parsed = TeamConfigCacheSchema.parse(cache);
  writeJson(teamConfigPath(key, revision, root), parsed);
  return parsed;
}
