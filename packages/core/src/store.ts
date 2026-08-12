import fs from "node:fs";
import path from "node:path";
import {
  EventSchema,
  FilesJsonSchema,
  MetaSchema,
  MigrationReportSchema,
  StateSchema,
} from "./schemas.js";
import type {
  FileDiff,
  FilesJson,
  Meta,
  MigrationReport,
  NewEvent,
  ReviewerEvent,
  State,
} from "./schemas.js";
import { fold } from "./reducer.js";
import {
  diffPath,
  eventsPath,
  filesJsonPath,
  metaPath,
  migrationReportPath,
  prDir,
  revisionDir,
  statePath,
  stateRoot,
  type PrKey,
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
          const key = { host, owner, repo, number: Number(number) };
          if (Number.isFinite(key.number) && prExists(key, root)) out.push(key);
        }
      }
    }
  }
  return out;
}
