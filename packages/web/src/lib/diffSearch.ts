/**
 * Plain-substring search over the whole parsed diff.
 *
 * The index is built from the rows `diffModel.buildRows` already produced for
 * rendering (themselves cached per hunk), so opening the search bar costs one
 * pass over lines that are in memory anyway — never a re-parse of the raw diff.
 * Order is diff order: files as `files.json` lists them, hunks as the file
 * lists them, rows top to bottom, matches left to right within a row.
 */

import type { FilesJson, ReviewUnit } from "../api/types";
import { buildRows, type CharRange, type LineType } from "./diffModel";

/** Which file the line belongs to — the same sense as a comment's side. */
export type MatchSide = "old" | "new";

export interface SearchLine {
  path: string;
  hunkId: string;
  /** index into the hunk's unified rows — the key the renderer addresses rows by */
  lineIdx: number;
  type: LineType;
  side: MatchSide;
  /** line number on `side`, when the row has one */
  line?: number;
  content: string;
  /** pre-lowered content, so a case-insensitive query never re-lowers the corpus */
  lower: string;
}

export interface DiffSearchIndex {
  lines: SearchLine[];
}

export interface SearchMatch {
  path: string;
  hunkId: string;
  lineIdx: number;
  side: MatchSide;
  line?: number;
  /** char offsets into the row's `content` (marker already stripped) */
  start: number;
  end: number;
}

export interface SearchOptions {
  caseSensitive?: boolean;
  /** default: only added/removed lines; false widens to context lines too */
  changedOnly?: boolean;
}

export function buildSearchIndex(files: FilesJson, diffText: string): DiffSearchIndex {
  const lines: SearchLine[] = [];
  for (const file of files.files) {
    for (const hunk of file.hunks) {
      const rows = buildRows(hunk, diffText);
      for (let lineIdx = 0; lineIdx < rows.length; lineIdx++) {
        const row = rows[lineIdx];
        const side: MatchSide = row.type === "del" ? "old" : "new";
        lines.push({
          path: file.path,
          hunkId: hunk.id,
          lineIdx,
          type: row.type,
          side,
          line: side === "old" ? row.oldNumber : row.newNumber,
          content: row.content,
          lower: row.content.toLowerCase(),
        });
      }
    }
  }
  return { lines };
}

/** Every occurrence, in diff order. Overlapping hits are not reported twice. */
export function searchDiff(
  index: DiffSearchIndex,
  query: string,
  options: SearchOptions = {},
): SearchMatch[] {
  const { caseSensitive = false, changedOnly = true } = options;
  const needle = caseSensitive ? query : query.toLowerCase();
  if (!needle) return [];

  const out: SearchMatch[] = [];
  for (const line of index.lines) {
    if (changedOnly && line.type !== "add" && line.type !== "del") continue;
    const hay = caseSensitive ? line.content : line.lower;
    let from = 0;
    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at === -1) break;
      out.push({
        path: line.path,
        hunkId: line.hunkId,
        lineIdx: line.lineIdx,
        side: line.side,
        line: line.line,
        start: at,
        end: at + needle.length,
      });
      from = at + needle.length;
    }
  }
  return out;
}

/** Address for a rendered row: hunk + its index into that hunk's unified rows. */
export function lineKey(hunkId: string, lineIdx: number): string {
  return `${hunkId}:${lineIdx}`;
}

/** Match ranges grouped per rendered row, so a row can highlight in one lookup. */
export function matchRangesByLine(matches: SearchMatch[]): Map<string, CharRange[]> {
  const map = new Map<string, CharRange[]>();
  for (const m of matches) {
    const key = lineKey(m.hunkId, m.lineIdx);
    const list = map.get(key);
    if (list) list.push({ start: m.start, end: m.end });
    else map.set(key, [{ start: m.start, end: m.end }]);
  }
  return map;
}

export function countsByFile(matches: SearchMatch[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const m of matches) map.set(m.path, (map.get(m.path) ?? 0) + 1);
  return map;
}

export function countsByHunk(matches: SearchMatch[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const m of matches) map.set(m.hunkId, (map.get(m.hunkId) ?? 0) + 1);
  return map;
}

/** Per-unit totals. A hunk shared by two units counts for both. */
export function countsByUnit(matches: SearchMatch[], units: ReviewUnit[]): Map<string, number> {
  const perHunk = countsByHunk(matches);
  const map = new Map<string, number>();
  for (const unit of units) {
    let total = 0;
    for (const id of unit.hunkIds) total += perHunk.get(id) ?? 0;
    if (total) map.set(unit.id, total);
  }
  return map;
}

/** The first unit (in the given order) that contains `hunkId`. */
export function unitForHunk(units: ReviewUnit[], hunkId: string): ReviewUnit | null {
  for (const unit of units) if (unit.hunkIds.includes(hunkId)) return unit;
  return null;
}
