import { diffWordsWithSpace } from "diff";
import { ATTENTIONS, type FileEntry, type FilesJson, type Hunk, type PrDetail, type ReviewUnit } from "../api/types";

export type LineType = "add" | "del" | "context" | "meta";

export interface CharRange {
  start: number;
  end: number;
}

export interface DiffRow {
  type: LineType;
  /** line content without the leading +/-/space marker */
  content: string;
  oldNumber?: number;
  newNumber?: number;
  /** char ranges (into `content`) that differ from the paired line */
  intra?: CharRange[];
}

const CACHE = new Map<string, DiffRow[]>();

/**
 * Fallback only. files.json normally carries each hunk's raw body (core's
 * `text`, surfaced as `hunk.lines` by the API client), so this is used solely
 * for state written before that field existed. We never re-derive structure —
 * only the text between the hunk's own @@ header and the next header.
 */
export function extractHunkBody(diffText: string, hunk: Hunk): string[] {
  if (!diffText) return [];
  const lines = diffText.split("\n");
  let inFile = false;
  const target = hunk.file;
  // NB: core's `hunk.header` is only the section heading after the `@@ … @@`
  // marker (often ""), so it can never be used to identify the hunk line.
  // Match on the line/count ranges instead.
  const headerPrefix = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  const shortPrefix = `@@ -${hunk.oldStart} +${hunk.newStart} @@`;
  const body: string[] = [];
  let collecting = false;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (collecting) break;
      inFile = line.endsWith(` b/${target}`) || line.includes(` b/${target} `);
      continue;
    }
    if (!inFile) continue;
    if (line.startsWith("@@")) {
      if (collecting) break;
      collecting = line.startsWith(headerPrefix) || line.startsWith(shortPrefix);
      continue;
    }
    if (collecting) {
      if (line.startsWith("\\")) continue; // "\ No newline at end of file"
      body.push(line);
    }
  }
  return body;
}

/** Build renderable rows (line numbers on both sides + word-level intra ranges). */
export function buildRows(hunk: Hunk, diffText: string): DiffRow[] {
  const cached = CACHE.get(hunk.id);
  if (cached) return cached;

  const body = hunk.lines?.length ? hunk.lines : extractHunkBody(diffText, hunk);
  const rows: DiffRow[] = [];
  let oldNo = hunk.oldStart || 1;
  let newNo = hunk.newStart || 1;

  for (const raw of body) {
    const marker = raw[0] ?? " ";
    const content = raw.length ? raw.slice(1) : "";
    if (marker === "+") {
      rows.push({ type: "add", content, newNumber: newNo++ });
    } else if (marker === "-") {
      rows.push({ type: "del", content, oldNumber: oldNo++ });
    } else {
      rows.push({ type: "context", content, oldNumber: oldNo++, newNumber: newNo++ });
    }
  }

  annotateIntraLine(rows);
  CACHE.set(hunk.id, rows);
  return rows;
}

/**
 * Pair consecutive removed/added runs positionally and compute word-level
 * ranges with the `diff` package. Only pairs of similar-enough lines get
 * highlighted; a wholesale rewrite reads better as a plain add/remove.
 */
function annotateIntraLine(rows: DiffRow[]) {
  let i = 0;
  while (i < rows.length) {
    if (rows[i].type !== "del") {
      i++;
      continue;
    }
    let d = i;
    while (d < rows.length && rows[d].type === "del") d++;
    let a = d;
    while (a < rows.length && rows[a].type === "add") a++;
    const dels = rows.slice(i, d);
    const adds = rows.slice(d, a);
    const pairs = Math.min(dels.length, adds.length);
    for (let p = 0; p < pairs; p++) {
      pairLines(dels[p], adds[p]);
    }
    i = a > i ? a : i + 1;
  }
}

function pairLines(del: DiffRow, add: DiffRow) {
  if (!del.content.trim() || !add.content.trim()) return;
  const parts = diffWordsWithSpace(del.content, add.content);
  const delRanges: CharRange[] = [];
  const addRanges: CharRange[] = [];
  let delPos = 0;
  let addPos = 0;
  let changed = 0;
  for (const part of parts) {
    const len = part.value.length;
    if (part.added) {
      addRanges.push({ start: addPos, end: addPos + len });
      addPos += len;
      changed += len;
    } else if (part.removed) {
      delRanges.push({ start: delPos, end: delPos + len });
      delPos += len;
      changed += len;
    } else {
      delPos += len;
      addPos += len;
    }
  }
  const total = del.content.length + add.content.length;
  // Everything changed → highlighting the whole line is noise.
  if (total === 0 || changed / total > 0.8) return;
  del.intra = delRanges;
  add.intra = addRanges;
}

/** One side of a side-by-side row. `null` is a filler cell (nothing there). */
export interface SplitCell {
  row: DiffRow;
  /** index into the hunk's unified rows — the key for shiki token lookup */
  index: number;
}

export interface SplitRow {
  left: SplitCell | null;
  right: SplitCell | null;
}

const SPLIT_CACHE = new Map<string, SplitRow[]>();

/**
 * Pair the unified rows into side-by-side rows: context occupies both sides,
 * and each del/add run is zipped positionally (left = removed, right = added)
 * with the shorter side padded by filler cells. The zip is intentionally the
 * same positional pairing `annotateIntraLine` uses, so the word-level ranges
 * already on the rows line up with the pairs shown here.
 */
export function buildSplitRows(hunk: Hunk, diffText: string): SplitRow[] {
  const cached = SPLIT_CACHE.get(hunk.id);
  if (cached) return cached;

  const rows = buildRows(hunk, diffText);
  const out: SplitRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.type !== "del" && row.type !== "add") {
      out.push({ left: { row, index: i }, right: { row, index: i } });
      i++;
      continue;
    }
    let d = i;
    while (d < rows.length && rows[d].type === "del") d++;
    let a = d;
    while (a < rows.length && rows[a].type === "add") a++;
    const dels = rows.slice(i, d);
    const adds = rows.slice(d, a);
    const n = Math.max(dels.length, adds.length);
    for (let p = 0; p < n; p++) {
      out.push({
        left: p < dels.length ? { row: dels[p], index: i + p } : null,
        right: p < adds.length ? { row: adds[p], index: d + p } : null,
      });
    }
    i = a;
  }

  SPLIT_CACHE.set(hunk.id, out);
  return out;
}

/**
 * A label for a hunk row. core stores only the section heading in `header`
 * (frequently empty), so the `@@` range is reconstructed here for display.
 */
export function hunkLabel(hunk: Hunk): string {
  const range = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  const heading = sectionHeading(hunk.header);
  return heading ? `${range} ${heading}` : range;
}

/**
 * `header` is *supposed* to be just the section heading, but some producers
 * (and our own mock fixture) store the whole `@@ … @@ heading` line. Appending
 * that to the reconstructed range printed the range twice, so strip it.
 */
export function sectionHeading(header: string | undefined | null): string {
  const trimmed = (header ?? "").trim();
  if (!trimmed.startsWith("@@")) return trimmed;
  const close = trimmed.indexOf("@@", 2);
  return close === -1 ? "" : trimmed.slice(close + 2).trim();
}

export function fileOf(files: FilesJson, path: string): FileEntry | undefined {
  return files.files.find((f) => f.path === path);
}

export function hunkIndex(files: FilesJson): Map<string, { hunk: Hunk; file: FileEntry }> {
  const map = new Map<string, { hunk: Hunk; file: FileEntry }>();
  for (const file of files.files) {
    for (const hunk of file.hunks) map.set(hunk.id, { hunk, file });
  }
  return map;
}

/** Hunks of a unit, in the order the unit declares, skipping unknown ids. */
export function unitHunks(detail: PrDetail, unit: ReviewUnit): { hunk: Hunk; file: FileEntry }[] {
  const index = hunkIndex(detail.files);
  const out: { hunk: Hunk; file: FileEntry }[] = [];
  for (const id of unit.hunkIds) {
    const entry = index.get(id);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * Units in the same reading order the sidebar numbers them: bucketed by
 * attention (must-read, then skim, then skip), and by `order` within each
 * bucket. `order` alone is gappy across buckets, so this is not a plain sort.
 */
export function sortUnitsForDisplay(units: ReviewUnit[]): ReviewUnit[] {
  return [...units].sort((a, b) => {
    const ra = ATTENTIONS.indexOf(a.attention);
    const rb = ATTENTIONS.indexOf(b.attention);
    return ra !== rb ? ra - rb : a.order - b.order;
  });
}

export function unitProgress(detail: PrDetail, unit: ReviewUnit) {
  let viewed = 0;
  let changed = 0;
  for (const id of unit.hunkIds) {
    const st = detail.state.hunks[id];
    if (st?.viewed) viewed++;
    if (st?.changedSinceViewed) changed++;
  }
  return { viewed, total: unit.hunkIds.length, changed };
}

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  mdx: "markdown",
  css: "css",
  scss: "scss",
  html: "html",
  yml: "yaml",
  yaml: "yaml",
  sql: "sql",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  toml: "toml",
  graphql: "graphql",
  gql: "graphql",
  vue: "vue",
  svelte: "svelte",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
};

export function languageFor(path: string): string | null {
  const base = path.split("/").pop() ?? path;
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  return LANG_BY_EXT[ext] ?? null;
}
