import { diffArrays } from "diff";
import type { PrKey } from "./paths.js";
import { stateRoot } from "./paths.js";
import type { ArchivedHunk, FileDiff, Hunk, MigrationEntry, MigrationReport } from "./schemas.js";
import { loadState, readFilesJson, readMigrationReport } from "./store.js";

/**
 * "What did revision N change, line by line, and where is it now?" — the data
 * behind highlighting one changelog revision's lines in the diff pane.
 *
 * Blame-style and positional. For each hunk N reworked or added, take the
 * *indexes* (into the hunk's body lines at N) of the lines N introduced: a
 * Myers line diff of body(N-1) vs body(N) for a reworked hunk, every '+' line
 * for a new one. Then walk forward through every later revision, following
 * the hunk id through that revision's migration report, and carry the
 * indexes along a positional diff of body(K) vs body(K+1): a line equal on
 * both sides moves to its new index, a line removed or rewritten is dropped
 * (and counted in `rewrittenSince`). What is left indexes into the current
 * hunk's body lines: the rows the web renders.
 *
 * The N-1 -> N diff is read as change blocks (maximal runs of non-equal lines
 * between equal ones). A block with additions is an edit (or a pure
 * addition): its added lines are marked, its removed lines are not reported
 * as removals. A block with only removals is a pure deletion: its '+'/'-'
 * lines count in `removedCount` (context lines leaving the body are only the
 * hunk's window shrinking), and where it was (the line right after it) is carried
 * forward as an anchor the same way marked lines are.
 *
 * Index space (the invariant the web relies on): body line `i` of a hunk is
 * `hunkBodyLines(hunk.text)[i]`, i.e. `text.split("\n")` with nothing
 * filtered — the same array the web client builds as `hunk.lines`
 * (`hunkBodyLines` in web's lib/diffModel.ts) and that `buildRows` /
 * `rawHunkLines` index. A "\ No newline at end of file" marker is a body line
 * there too (the web renders it as a row); it is never reported as
 * introduced or removed.
 */

/** A hunk's reported lines are capped at this many; a whole new file is fine, a vendored blob is not. */
export const MAX_INTRODUCED_LINES = 2000;

export type LineChangeStatus = "fuzzy" | "renamed" | "new";

/** Where a pure deletion of revision N sits in the current hunk. */
export interface RemovedAnchor {
  /**
   * Current body line index of the line right after the deleted run; equal
   * to the body's length when the run was at the very end of the hunk.
   */
  line: number;
  /** lines the run deleted */
  count: number;
}

export interface HunkLineChange {
  /** the hunk's id in the current revision, where the web renders it */
  currentHunkId: string;
  /** its id in revision N, where these lines were introduced */
  originHunkId: string;
  /** its file in the current revision */
  file: string;
  status: LineChangeStatus;
  /**
   * Indexes, sorted, into the current hunk's body lines ({@link hunkBodyLines})
   * of the lines N introduced that are still there unchanged.
   */
  lines: number[];
  /** lines N deleted outright (pure-deletion blocks only; an edit's old side is not counted) */
  removedCount: number;
  /** the deletions whose position survives to the current revision, sorted by line */
  removedAt: RemovedAnchor[];
  /** how many of the lines N introduced a later revision rewrote or removed */
  rewrittenSince: number;
  /** no revision after N changed this hunk's body: it is the one N produced */
  exactAtCurrent: boolean;
  /**
   * A later revision's report or hunk body was missing, so some step was
   * assumed to carry the lines over unchanged: the marks may be off.
   */
  uncertain?: boolean;
  /** `lines` was cut at MAX_INTRODUCED_LINES */
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
   * carry over.
   */
  laterReports: (MigrationReport | null)[];
  /** the revision numbers `laterReports` stand for; defaults to each report's own, else N+1, N+2, … */
  laterRevisions?: number[];
  /**
   * Hunks of a later revision, to carry positions across it. The current
   * revision's come from `currentFiles`. A step whose bodies are unknown is
   * assumed to keep positions (and flagged `uncertain` unless `identical`).
   */
  filesAt?: (revision: number) => FileDiff[] | undefined;
  /** the current revision's hunks, to confirm the mapped id really is there */
  currentFiles?: FileDiff[];
  /** the state's archived shelf, to attribute gone hunks to units */
  archived?: ArchivedHunk[];
}

/**
 * A hunk body in the index space every position here refers to: the raw
 * lines of `text`, prefix included, nothing filtered. Must stay equal to the
 * web's `hunkBodyLines` (web lib/diffModel.ts), which builds `hunk.lines`.
 */
export function hunkBodyLines(text: string | undefined): string[] {
  return text ? text.split("\n") : [];
}

/** A '+' or '-' line: code the PR itself adds or deletes. */
function isDiffLine(line: string): boolean {
  return line.startsWith("+") || line.startsWith("-");
}

/** "\ No newline at end of file": a row, but not code. */
function isMarker(line: string): boolean {
  return line.startsWith("\\");
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

/** One maximal run of non-equal lines between two equal ones (or a body edge). */
export interface ChangeBlock {
  /** indexes in `before` */
  removed: number[];
  /** indexes in `after` */
  added: number[];
  /** index in `after` of the first line past the block (after.length at the end) */
  end: number;
}

export interface BodyAlignment {
  /** index in `before` -> index in `after`, for lines equal on both sides */
  kept: Map<number, number>;
  blocks: ChangeBlock[];
}

/**
 * Positional (Myers) line diff of two hunk bodies, over raw lines with their
 * ' '/'+'/'-' prefix, grouped into change blocks.
 */
export function alignBodies(before: readonly string[], after: readonly string[]): BodyAlignment {
  const kept = new Map<number, number>();
  const blocks: ChangeBlock[] = [];
  let open: ChangeBlock | null = null;
  let i = 0;
  let j = 0;
  for (const part of diffArrays(before as string[], after as string[])) {
    const n = part.count ?? part.value.length;
    if (!part.added && !part.removed) {
      if (open) {
        open.end = j;
        blocks.push(open);
        open = null;
      }
      for (let k = 0; k < n; k++) kept.set(i++, j++);
      continue;
    }
    open ??= { removed: [], added: [], end: 0 };
    if (part.added) for (let k = 0; k < n; k++) open.added.push(j++);
    else for (let k = 0; k < n; k++) open.removed.push(i++);
  }
  if (open) {
    open.end = j;
    blocks.push(open);
  }
  return { kept, blocks };
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((l, i) => l === b[i]);
}

interface Step {
  /** previousHunkId -> entry, for identical/fuzzy/renamed */
  forward: Map<string, MigrationEntry>;
  revision: number;
}

function stepOf(report: MigrationReport): Step {
  const forward = new Map<string, MigrationEntry>();
  for (const e of report.entries) {
    if (e.status !== "archived" && e.previousHunkId) forward.set(e.previousHunkId, e);
  }
  return { forward, revision: report.revision };
}

interface Origin {
  originHunkId: string;
  file: string;
  status: LineChangeStatus;
  body: string[];
  /** indexes into `body` */
  lines: number[];
  removedCount: number;
  removedAt: RemovedAnchor[];
}

/** What N did to one reworked hunk: marked lines and pure deletions. */
function originDelta(prevBody: string[], body: string[]): Pick<Origin, "lines" | "removedCount" | "removedAt"> {
  const lines: number[] = [];
  const removedAt: RemovedAnchor[] = [];
  let removedCount = 0;
  for (const b of alignBodies(prevBody, body).blocks) {
    // Only diff lines count, on both sides. A context line entering the body
    // is the hunk's window growing around an edit — unchanged code, which a
    // yellow "changed in rN" bar would misrepresent — and one leaving it is
    // the window shrinking, not code N deleted. So a block that only swaps
    // context for context is nothing, and one that trades diff lines for
    // context is a pure deletion.
    const added = b.added.filter((k) => isDiffLine(body[k]));
    const removed = b.removed.filter((k) => isDiffLine(prevBody[k]));
    if (added.length > 0) {
      lines.push(...added); // an edit, or a pure addition
    } else if (removed.length > 0) {
      removedCount += removed.length;
      removedAt.push({ line: b.end, count: removed.length });
    }
  }
  return { lines, removedCount, removedAt };
}

/**
 * Pure core of {@link revisionLineChanges}: everything it needs is passed in,
 * so it can be tested without a state dir.
 */
export function computeRevisionLineChanges(input: RevisionLineChangesInput): RevisionLineChanges {
  const { revision, currentRevision, report } = input;
  const atN = hunkMap(input.revisionFiles);
  const before = hunkMap(input.previousFiles);

  // 1. What N changed, per hunk, as positions in N's own bodies.
  const changed: Origin[] = [];
  const entries: MigrationEntry[] = report
    ? report.entries
    : [...atN.values()].map((h) => ({ status: "new" as const, hunkId: h.id, file: h.file }));
  for (const e of entries) {
    if (e.status !== "fuzzy" && e.status !== "renamed" && e.status !== "new") continue;
    const after = atN.get(e.hunkId);
    if (!after) continue;
    const body = hunkBodyLines(after.text);
    if (e.status === "new") {
      const lines: number[] = [];
      body.forEach((l, k) => {
        if (l.startsWith("+")) lines.push(k);
      });
      changed.push({ originHunkId: e.hunkId, file: e.file, status: "new", body, lines, removedCount: 0, removedAt: [] });
      continue;
    }
    const prev = e.previousHunkId ? before.get(e.previousHunkId) : undefined;
    // `renamed` with the same content only moved the file: nothing to show.
    if (e.status === "renamed" && (!prev || sameContent(prev, after))) continue;
    if (!prev) continue;
    const delta = originDelta(hunkBodyLines(prev.text), body);
    if (delta.lines.length === 0 && delta.removedCount === 0) continue;
    changed.push({ originHunkId: e.hunkId, file: e.file, status: e.status, body, ...delta });
  }

  // 2. Carry each forward, positionally, to the current revision.
  const steps = input.laterReports.map((r) => (r ? stepOf(r) : null));
  const stepRevision = (k: number): number =>
    input.laterRevisions?.[k] ?? input.laterReports[k]?.revision ?? revision + k + 1;
  const current = input.currentFiles ? hunkMap(input.currentFiles) : null;
  const filesCache = new Map<number, Map<string, Hunk> | null>();
  const hunksAt = (rev: number): Map<string, Hunk> | null => {
    if (rev === currentRevision && current) return current;
    if (!filesCache.has(rev)) {
      const f = input.filesAt?.(rev);
      filesCache.set(rev, f ? hunkMap(f) : null);
    }
    return filesCache.get(rev) ?? null;
  };
  const archivedUnit = new Map<string, string>();
  for (const a of input.archived ?? []) {
    if (a.unitId) archivedUnit.set(`${a.archivedAtRevision}:${a.hunkId}`, a.unitId);
  }

  const hunks: HunkLineChange[] = [];
  const gone: GoneHunk[] = [];
  for (const c of changed) {
    let id = c.originHunkId;
    let file = c.file;
    let body: string[] | undefined = c.body;
    let lines = c.lines;
    let anchors = c.removedAt;
    let rewrittenSince = 0;
    let exact = true;
    let uncertain = false;
    let goneAt: number | undefined;
    for (let k = 0; k < steps.length; k++) {
      const step = steps[k];
      let status: MigrationEntry["status"] | "unknown" = "unknown";
      if (step) {
        const next = step.forward.get(id);
        if (!next) {
          goneAt = step.revision;
          break;
        }
        status = next.status;
        id = next.hunkId;
        file = next.file;
      }
      if (status !== "identical") exact = false;
      const nextHunk = hunksAt(step?.revision ?? stepRevision(k))?.get(id);
      const nextBody = nextHunk ? hunkBodyLines(nextHunk.text) : undefined;
      if (body && nextBody) {
        if (!sameLines(body, nextBody)) {
          // `identical` ids can still differ in context lines: follow the body.
          exact = false;
          const { kept } = alignBodies(body, nextBody);
          const mapped: number[] = [];
          for (const l of lines) {
            const to = kept.get(l);
            if (to === undefined) rewrittenSince++;
            else mapped.push(to);
          }
          lines = mapped;
          const oldLen = body.length;
          const newLen = nextBody.length;
          anchors = anchors.flatMap((a) => {
            const to = a.line >= oldLen ? newLen : kept.get(a.line);
            return to === undefined ? [] : [{ ...a, line: to }];
          });
        }
      } else {
        // A body we can't see: assume positions carried over.
        exact = false;
        if (status !== "identical") uncertain = true;
      }
      body = nextBody;
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
    if (body) {
      const len = body.length;
      lines = lines.filter((l) => l < len);
      anchors = anchors.filter((a) => a.line <= len);
    }
    lines = [...lines].sort((x, y) => x - y);
    anchors = [...anchors].sort((x, y) => x.line - y.line);
    const truncated = lines.length > MAX_INTRODUCED_LINES;
    hunks.push({
      currentHunkId: id,
      originHunkId: c.originHunkId,
      file,
      status: c.status,
      lines: truncated ? lines.slice(0, MAX_INTRODUCED_LINES) : lines,
      removedCount: c.removedCount,
      removedAt: anchors,
      rewrittenSince,
      exactAtCurrent: exact,
      ...(uncertain ? { uncertain } : {}),
      ...(truncated ? { truncated } : {}),
    });
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
 * N-1's) files, N's migration report, every later report, and later
 * revisions' files on demand from the state dir. Throws
 * {@link UnknownRevisionError} for a revision the PR never had.
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
  const tryFiles = (r: number): FileDiff[] | undefined => {
    try {
      return readFilesJson(key, r, root).files;
    } catch {
      return undefined;
    }
  };
  const report = readMigrationReport(key, revision, root);
  const prevRevision = report?.previousRevision ?? known[known.indexOf(revision) - 1];
  const previousFiles = report && prevRevision !== undefined ? tryFiles(prevRevision) : undefined;
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
    laterRevisions: later,
    filesAt: tryFiles,
    currentFiles,
    archived: state.archived,
  });
}
