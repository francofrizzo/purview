import { computeHunkId, disambiguate } from "./hunk-id.js";
import type {
  FileDiff,
  Hunk,
  HunkState,
  MigrationEntry,
  MigrationReport,
  RevisionFiles,
} from "./schemas.js";

export const FUZZY_THRESHOLD = 0.6;

/** Hunks with this many or fewer changed (added+removed) lines on either
 * side get the token-level similarity fallback blended in (see `jaccard`). */
const SMALL_HUNK_CHANGED_LINES = 6;

/** Jaccard similarity over the set of added+removed lines of two hunks. */
function lineJaccard(a: Hunk, b: Hunk): number {
  const sa = new Set([...a.addedLines, ...a.removedLines]);
  const sb = new Set([...b.addedLines, ...b.removedLines]);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function tokenize(line: string): string[] {
  return line.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
}

function tokenSet(lines: string[]): Set<string> {
  const out = new Set<string>();
  for (const line of lines) for (const t of tokenize(line)) out.add(t);
  return out;
}

/** Jaccard similarity over the word tokens of two hunks' added+removed lines. */
function tokenJaccard(a: Hunk, b: Hunk): number {
  const ta = tokenSet([...a.addedLines, ...a.removedLines]);
  const tb = tokenSet([...b.addedLines, ...b.removedLines]);
  if (ta.size === 0 && tb.size === 0) return 1;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function changedLineCount(h: Hunk): number {
  return h.addedLines.length + h.removedLines.length;
}

/**
 * Similarity used for fuzzy hunk matching (SPEC "Migration" 2b).
 *
 * Whole-line Jaccard is precise and conservative for larger hunks: sharing
 * whole unchanged lines is strong evidence of "same hunk", and word-level
 * overlap would be noisy there (common keywords/punctuation inflate scores
 * across unrelated hunks). But it's the wrong granularity for small hunks —
 * a 2-line hunk with a single line edited in place (e.g. one argument added)
 * shares zero identical whole lines even though it's obviously the same
 * edit, so it scores ~0 and falls below threshold, losing viewed state.
 *
 * Fix: for hunks where either side has <= SMALL_HUNK_CHANGED_LINES changed
 * lines, blend in a word-token Jaccard and take the max of the two scores.
 * Large hunks are unaffected (line-Jaccard only), so existing behavior for
 * them is unchanged.
 */
export function jaccard(a: Hunk, b: Hunk): number {
  const line = lineJaccard(a, b);
  const isSmall =
    changedLineCount(a) <= SMALL_HUNK_CHANGED_LINES ||
    changedLineCount(b) <= SMALL_HUNK_CHANGED_LINES;
  if (!isSmall) return line;
  return Math.max(line, tokenJaccard(a, b));
}

function sameContent(a: Hunk, b: Hunk): boolean {
  return (
    a.addedLines.join("\n") === b.addedLines.join("\n") &&
    a.removedLines.join("\n") === b.removedLines.join("\n")
  );
}

/** file -> hunk ids, the shape carried on `revision-added` events. */
export function toRevisionFiles(files: FileDiff[]): RevisionFiles[] {
  return files.map((f) => ({
    path: f.path,
    oldPath: f.oldPath,
    hunkIds: f.hunks.map((h) => h.id),
  }));
}

interface Indexed {
  hunk: Hunk;
  /** path this hunk had in the previous revision (rename-aware) */
  matchPath: string;
  /** id this hunk would have had under `matchPath` (rename-aware) */
  matchId: string;
}

function indexNew(files: FileDiff[]): Indexed[] {
  const out: Indexed[] = [];
  for (const f of files) {
    const matchPath = f.oldPath ?? f.path;
    const renamed = matchPath !== f.path;
    const seen = new Map<string, number>();
    for (const h of f.hunks) {
      // Under a rename the id changes even when the content did not; recompute
      // what this hunk's id was under the old path so (a)/(c) can match.
      const matchId = renamed
        ? disambiguate(
            computeHunkId(matchPath, h.addedLines, h.removedLines),
            seen,
          )
        : h.id;
      out.push({ hunk: h, matchPath, matchId });
    }
  }
  return out;
}

export interface MigrateInput {
  revision: number;
  previousRevision?: number;
  previousFiles: FileDiff[];
  nextFiles: FileDiff[];
  /** hunk state as of the previous revision (used to report viewed carryover) */
  hunkStates?: Record<string, HunkState>;
  /** headSha unchanged but mergeBase moved */
  baseOnly?: boolean;
}

/**
 * Match the previous revision's hunks onto the new revision's hunks per SPEC
 * "Migration": identical id -> fuzzy (Jaccard >= 0.6, same file, best match,
 * 1:1) -> rename-aware recompute; unmatched old is archived, unmatched new is
 * `new`.
 */
export function migrate(input: MigrateInput): MigrationReport {
  const states = input.hunkStates ?? {};
  const oldHunks: Hunk[] = input.previousFiles.flatMap((f) => f.hunks);
  const oldById = new Map(oldHunks.map((h) => [h.id, h]));
  const newIndexed = indexNew(input.nextFiles);

  const usedOld = new Set<string>();
  const entries: MigrationEntry[] = [];
  const matchedNew = new Set<string>();

  const record = (
    status: MigrationEntry["status"],
    n: Indexed,
    old: Hunk,
    score?: number,
  ) => {
    const st = states[old.id];
    const wasViewed = st?.viewed ?? false;
    const contentChanged = !sameContent(old, n.hunk);
    const changedSinceViewed = contentChanged
      ? wasViewed
      : (st?.changedSinceViewed ?? false);
    entries.push({
      status,
      hunkId: n.hunk.id,
      previousHunkId: old.id,
      file: n.hunk.file,
      previousFile: old.file !== n.hunk.file ? old.file : undefined,
      score,
      wasViewed,
      changedSinceViewed,
    });
    usedOld.add(old.id);
    matchedNew.add(n.hunk.id);
  };

  // (a) identical hunk id, and (c) rename-aware identical content.
  for (const n of newIndexed) {
    const direct = oldById.get(n.hunk.id);
    if (direct && !usedOld.has(direct.id)) {
      record("identical", n, direct, 1);
      continue;
    }
    if (n.matchId !== n.hunk.id) {
      const renamed = oldById.get(n.matchId);
      if (renamed && !usedOld.has(renamed.id)) {
        record("renamed", n, renamed, 1);
      }
    }
  }

  // (b) fuzzy: same file (rename-aware), Jaccard >= threshold, best-first,
  // each new hunk matches at most one old hunk and vice versa.
  const candidates: { n: Indexed; old: Hunk; score: number }[] = [];
  for (const n of newIndexed) {
    if (matchedNew.has(n.hunk.id)) continue;
    for (const old of oldHunks) {
      if (usedOld.has(old.id)) continue;
      if (old.file !== n.matchPath) continue;
      const score = jaccard(old, n.hunk);
      if (score >= FUZZY_THRESHOLD) candidates.push({ n, old, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  for (const c of candidates) {
    if (matchedNew.has(c.n.hunk.id) || usedOld.has(c.old.id)) continue;
    const renamedFile = c.n.matchPath !== c.n.hunk.file;
    const identicalContent = sameContent(c.old, c.n.hunk);
    const status: MigrationEntry["status"] =
      identicalContent && renamedFile ? "renamed" : "fuzzy";
    record(status, c.n, c.old, c.score);
  }

  // (e) unmatched new hunks
  for (const n of newIndexed) {
    if (matchedNew.has(n.hunk.id)) continue;
    entries.push({
      status: "new",
      hunkId: n.hunk.id,
      file: n.hunk.file,
    });
  }

  // (d) unmatched old hunks are archived
  for (const old of oldHunks) {
    if (usedOld.has(old.id)) continue;
    entries.push({
      status: "archived",
      hunkId: old.id,
      file: old.file,
      wasViewed: states[old.id]?.viewed ?? false,
    });
  }

  const counts = {
    identical: 0,
    fuzzy: 0,
    renamed: 0,
    archived: 0,
    new: 0,
  };
  for (const e of entries) counts[e.status]++;

  return {
    revision: input.revision,
    previousRevision: input.previousRevision,
    baseOnly: input.baseOnly ?? false,
    counts,
    entries,
  };
}

/** Human-readable rendering of a migration report (used by the CLI). */
export function formatMigrationReport(report: MigrationReport): string {
  const lines: string[] = [];
  lines.push(
    `Migration r${report.previousRevision ?? "-"} -> r${report.revision}` +
      (report.baseOnly ? "  (base moved only)" : ""),
  );
  lines.push(
    `  carried: ${report.counts.identical} identical, ${report.counts.fuzzy} fuzzy, ` +
      `${report.counts.renamed} renamed | ${report.counts.new} new, ${report.counts.archived} archived`,
  );
  for (const e of report.entries) {
    if (e.status === "identical") continue;
    const parts = [`  ${e.status.padEnd(8)} ${e.hunkId}  ${e.file}`];
    if (e.previousHunkId) parts.push(`<- ${e.previousHunkId}`);
    if (e.previousFile) parts.push(`(was ${e.previousFile})`);
    if (e.score !== undefined && e.status === "fuzzy")
      parts.push(`score=${e.score.toFixed(2)}`);
    if (e.changedSinceViewed) parts.push("[changed since viewed]");
    lines.push(parts.join(" "));
  }
  return lines.join("\n");
}
