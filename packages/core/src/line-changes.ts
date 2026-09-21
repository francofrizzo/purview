import { diffOfDiffs } from "./diff-of-diffs.js";
import type { PrKey } from "./paths.js";
import { stateRoot } from "./paths.js";
import type { ArchivedHunk, FileDiff, Hunk, MigrationEntry, MigrationReport } from "./schemas.js";
import { loadState, readFilesJson, readMigrationReport } from "./store.js";

/**
 * "What did revision N change, line by line, and where is it now?" — the data
 * behind highlighting one changelog revision's lines in the diff pane.
 *
 * A hunk's id is derived from its content, so every revision that touches a
 * hunk hands it a new id; the per-revision migration reports record each
 * step. This walks revision N's reworked and new hunks forward through those
 * reports to the hunk ids the current revision shows, and carries the lines
 * N introduced along. The web matches them back onto rendered rows by content.
 */

/** A new hunk's introduced lines are capped at this many; a whole new file is fine, a vendored blob is not. */
export const MAX_INTRODUCED_LINES = 2000;

export type LineChangeStatus = "fuzzy" | "renamed" | "new";

export interface HunkLineChange {
  /** the hunk's id in the current revision, where the web renders it */
  currentHunkId: string;
  /** its id in revision N, where these lines were introduced */
  originHunkId: string;
  /** its file in the current revision */
  file: string;
  status: LineChangeStatus;
  /**
   * Body lines (with their ' '/'+'/'-' prefix) present at N but not at N-1,
   * as a multiset: a line introduced twice appears twice.
   */
  introduced: string[];
  /** how many body lines N-1 had that N dropped */
  droppedCount: number;
  /** no revision after N touched this hunk: its body now is the one N produced */
  exactAtCurrent: boolean;
  /** `introduced` was cut at MAX_INTRODUCED_LINES */
  truncated?: boolean;
}

export interface GoneHunk {
  originHunkId: string;
  /** the id it had when it left the PR */
  lastHunkId: string;
  file: string;
  /** the revision whose migration archived it */
  goneAtRevision: number;
  /** the live unit that held it when it was archived, when the state knows */
  unitId?: string;
}

export interface RevisionLineChanges {
  revision: number;
  currentRevision: number;
  hunks: HunkLineChange[];
  /** hunks N changed that no longer exist in the current revision */
  goneCount: number;
  gone: GoneHunk[];
}

export interface RevisionLineChangesInput {
  revision: number;
  currentRevision: number;
  /** migration report into revision N; absent means N is the first revision (everything is new) */
  report: MigrationReport | undefined;
  /** hunks of revision N */
  revisionFiles: FileDiff[];
  /** hunks of the revision before N (report.previousRevision) */
  previousFiles?: FileDiff[];
  /**
   * Reports for every revision after N up to the current one, in order. A
   * `null` stands for a revision whose report is missing: ids are assumed to
   * carry over, but the result can no longer claim to be exact.
   */
  laterReports: (MigrationReport | null)[];
  /** the current revision's hunks, to confirm the mapped id really is there */
  currentFiles?: FileDiff[];
  /** the state's archived shelf, to attribute gone hunks to units */
  archived?: ArchivedHunk[];
}

function hunkMap(files: FileDiff[] | undefined): Map<string, Hunk> {
  const out = new Map<string, Hunk>();
  for (const f of files ?? []) for (const h of f.hunks) out.set(h.id, h);
  return out;
}

function sameContent(a: Hunk, b: Hunk): boolean {
  return (
    a.addedLines.join("\n") === b.addedLines.join("\n") &&
    a.removedLines.join("\n") === b.removedLines.join("\n")
  );
}

/** Raw body lines a highlight can match on; "\ No newline" markers are not code. */
function bodyLines(h: Hunk): string[] {
  if (!h.text) return [];
  return h.text.split("\n").filter((l) => !l.startsWith("\\"));
}

/**
 * The line diff of one hunk body between two revisions, over the raw body
 * lines including their diff prefix. Reuses the diff-of-diffs line pairing.
 */
export function bodyLineDelta(before: Hunk, after: Hunk): { introduced: string[]; dropped: string[] } {
  const clean = (h: Hunk) => bodyLines(h).join("\n");
  const introduced: string[] = [];
  const dropped: string[] = [];
  for (const l of diffOfDiffs(clean(before), clean(after)).lines) {
    if ((l.type === "added" || l.type === "modified") && l.newLine !== undefined) introduced.push(l.newLine);
    if ((l.type === "removed" || l.type === "modified") && l.oldLine !== undefined) dropped.push(l.oldLine);
  }
  return { introduced, dropped };
}

interface Step {
  /** previousHunkId -> entry, for identical/fuzzy/renamed */
  forward: Map<string, MigrationEntry>;
  /** hunk ids this step archived */
  archived: Map<string, MigrationEntry>;
  revision: number;
}

function stepOf(report: MigrationReport): Step {
  const forward = new Map<string, MigrationEntry>();
  const archived = new Map<string, MigrationEntry>();
  for (const e of report.entries) {
    if (e.status === "archived") archived.set(e.hunkId, e);
    else if (e.previousHunkId) forward.set(e.previousHunkId, e);
  }
  return { forward, archived, revision: report.revision };
}

/**
 * Pure core of {@link revisionLineChanges}: everything it needs is passed in,
 * so it can be tested without a state dir.
 */
export function computeRevisionLineChanges(input: RevisionLineChangesInput): RevisionLineChanges {
  const { revision, currentRevision, report } = input;
  const atN = hunkMap(input.revisionFiles);
  const before = hunkMap(input.previousFiles);

  // 1. What N changed, per hunk, in N's own ids.
  const changed: Omit<HunkLineChange, "currentHunkId" | "exactAtCurrent">[] = [];
  const entries: MigrationEntry[] = report
    ? report.entries
    : [...atN.values()].map((h) => ({ status: "new" as const, hunkId: h.id, file: h.file }));
  for (const e of entries) {
    if (e.status !== "fuzzy" && e.status !== "renamed" && e.status !== "new") continue;
    const after = atN.get(e.hunkId);
    if (!after) continue;
    if (e.status === "new") {
      const added = bodyLines(after).filter((l) => l.startsWith("+"));
      const truncated = added.length > MAX_INTRODUCED_LINES;
      changed.push({
        originHunkId: e.hunkId,
        file: e.file,
        status: "new",
        introduced: truncated ? added.slice(0, MAX_INTRODUCED_LINES) : added,
        droppedCount: 0,
        ...(truncated ? { truncated } : {}),
      });
      continue;
    }
    const prev = e.previousHunkId ? before.get(e.previousHunkId) : undefined;
    // `renamed` with the same content only moved the file: nothing to show.
    if (e.status === "renamed" && (!prev || sameContent(prev, after))) continue;
    if (!prev) continue;
    const delta = bodyLineDelta(prev, after);
    if (delta.introduced.length === 0 && delta.dropped.length === 0) continue;
    const truncated = delta.introduced.length > MAX_INTRODUCED_LINES;
    changed.push({
      originHunkId: e.hunkId,
      file: e.file,
      status: e.status,
      introduced: truncated ? delta.introduced.slice(0, MAX_INTRODUCED_LINES) : delta.introduced,
      droppedCount: delta.dropped.length,
      ...(truncated ? { truncated } : {}),
    });
  }

  // 2. Follow each forward to the current revision.
  const steps = input.laterReports.map((r) => (r ? stepOf(r) : null));
  const current = input.currentFiles ? hunkMap(input.currentFiles) : null;
  const archivedUnit = new Map<string, string>();
  for (const a of input.archived ?? []) {
    if (a.unitId) archivedUnit.set(`${a.archivedAtRevision}:${a.hunkId}`, a.unitId);
  }

  const hunks: HunkLineChange[] = [];
  const gone: GoneHunk[] = [];
  for (const c of changed) {
    let id = c.originHunkId;
    let file = c.file;
    let exact = true;
    let goneAt: number | undefined;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step) {
        exact = false; // unknown step: assume it carried over
        continue;
      }
      const next = step.forward.get(id);
      if (next) {
        if (next.status !== "identical") exact = false;
        id = next.hunkId;
        file = next.file;
        continue;
      }
      goneAt = step.revision;
      break;
    }
    if (goneAt === undefined && current && !current.has(id)) goneAt = currentRevision;
    if (goneAt !== undefined) {
      const unitId = archivedUnit.get(`${goneAt}:${id}`);
      gone.push({
        originHunkId: c.originHunkId,
        lastHunkId: id,
        file,
        goneAtRevision: goneAt,
        ...(unitId ? { unitId } : {}),
      });
      continue;
    }
    hunks.push({ ...c, currentHunkId: id, file, exactAtCurrent: exact });
  }

  return { revision, currentRevision, hunks, goneCount: gone.length, gone };
}

export class UnknownRevisionError extends Error {
  constructor(revision: number) {
    super(`No revision ${revision} on record`);
    this.name = "UnknownRevisionError";
  }
}

/**
 * Loader around {@link computeRevisionLineChanges}: reads revision N's (and
 * N-1's) files, N's migration report, every later report and the current
 * files from the state dir. Throws {@link UnknownRevisionError} for a
 * revision the PR never had.
 */
export function revisionLineChanges(
  key: PrKey,
  revision: number,
  root = stateRoot(),
): RevisionLineChanges {
  const state = loadState(key, root);
  const known = [...new Set([...state.revisions.map((r) => r.revision), state.currentRevision])].sort(
    (a, b) => a - b,
  );
  if (!Number.isInteger(revision) || !known.includes(revision) || revision > state.currentRevision) {
    throw new UnknownRevisionError(revision);
  }
  let revisionFiles: FileDiff[];
  try {
    revisionFiles = readFilesJson(key, revision, root).files;
  } catch {
    throw new UnknownRevisionError(revision);
  }
  const report = readMigrationReport(key, revision, root);
  const prevRevision = report?.previousRevision ?? known[known.indexOf(revision) - 1];
  let previousFiles: FileDiff[] | undefined;
  if (report && prevRevision !== undefined) {
    try {
      previousFiles = readFilesJson(key, prevRevision, root).files;
    } catch {
      previousFiles = undefined;
    }
  }
  const later = known.filter((r) => r > revision && r <= state.currentRevision);
  const laterReports = later.map((r) => readMigrationReport(key, r, root) ?? null);
  const currentFiles =
    revision === state.currentRevision ? revisionFiles : readFilesJson(key, state.currentRevision, root).files;

  return computeRevisionLineChanges({
    revision,
    currentRevision: state.currentRevision,
    report,
    revisionFiles,
    previousFiles,
    laterReports,
    currentFiles,
    archived: state.archived,
  });
}
