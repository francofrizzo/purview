/**
 * What a code span in a chat reply points at, if anything the PR view can
 * open. The model already writes units as `unit-id`, places as
 * `path/to/file.go:23` (or `file.go:~551-567`, `file.go`) and hunks by the id
 * the review tools gave it (`33f3566ed5be27f2`), so these are read straight
 * from what it writes rather than taught a link syntax.
 */

import type { FileEntry, Hunk, PrDetail, ReviewUnit } from "../api/types";
import type { CodeLink } from "../components/Markdown";
import { shownFindings } from "./diffModel";
import { unitDisplayNumbers } from "./unitOrder";

export type CodeTarget =
  | { kind: "unit"; unitId: string }
  | { kind: "file"; path: string; line?: number };

/** `path` or `path:12`, `path:~12`, `path:12-40` (an en dash too). */
const PATH_REF = /^(?:\.\/)?([^\s:`]+?)(?::~?(\d+)(?:\s*[-–]\s*~?\d+)?)?$/;

/**
 * The diff file a written path names: an exact path, else the one file whose
 * path ends with it (`intermediary.go`, `llm/chatbot.go`). Ambiguous or
 * unknown paths name nothing, so a link never guesses.
 */
export function resolveDiffPath(written: string, files: Pick<FileEntry, "path">[]): string | null {
  if (!written.includes(".") && !written.includes("/")) return null;
  const exact = files.find((f) => f.path === written);
  if (exact) return exact.path;
  const tail = `/${written}`;
  const matches = files.filter((f) => f.path.endsWith(tail));
  return matches.length === 1 ? matches[0].path : null;
}

export function resolveCodeTarget(
  text: string,
  ctx: { unitIds: ReadonlySet<string>; files: Pick<FileEntry, "path">[] },
): CodeTarget | null {
  const t = text.trim();
  if (ctx.unitIds.has(t)) return { kind: "unit", unitId: t };
  const m = PATH_REF.exec(t);
  if (!m) return null;
  const path = resolveDiffPath(m[1], ctx.files);
  if (!path) return null;
  return m[2] ? { kind: "file", path, line: Number(m[2]) } : { kind: "file", path };
}

/**
 * A finding's `evidence` ("src/a.ts:64, src/b.ts:31") cut into the places it
 * names and the text between them, so each place can be linked on its own.
 * `ref` pieces are candidates only: whether one opens anything is the
 * linker's call. A trailing `.` or `:` stays text.
 */
export function evidenceParts(evidence: string): { text: string; ref?: true }[] {
  const parts: { text: string; ref?: true }[] = [];
  let at = 0;
  for (const m of evidence.matchAll(/[^\s,;()`'"]+/g)) {
    const token = m[0].replace(/[.:]+$/, "");
    if (!token) continue;
    if (m.index > at) parts.push({ text: evidence.slice(at, m.index) });
    parts.push({ text: token, ref: true });
    at = m.index + token.length;
  }
  if (at < evidence.length) parts.push({ text: evidence.slice(at) });
  return parts;
}

/**
 * The diff lines the units' warnings cite, as `path:line` (new side) to the
 * warnings' text, so the diff can mark each one in its gutter. A place the
 * diff does not show (a caller outside the PR) has no line to mark; the
 * unit's findings list still carries it.
 */
export function warningLines(
  units: Pick<ReviewUnit, "findings">[],
  files: Pick<FileEntry, "path">[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const u of units) {
    for (const f of shownFindings(u.findings)) {
      const places = new Set<string>();
      for (const part of evidenceParts(f.evidence)) {
        if (!part.ref) continue;
        const t = resolveCodeTarget(part.text, { unitIds: new Set(), files });
        if (t?.kind === "file" && t.line !== undefined) places.add(`${t.path}:${t.line}`);
      }
      for (const key of places) out.set(key, [...(out.get(key) ?? []), f.text]);
    }
  }
  return out;
}

/** The hunk showing `line` on the new side, if the diff shows it at all. */
export function hunkAtLine(
  hunks: Pick<Hunk, "id" | "newStart" | "newLines">[],
  line: number,
): string | null {
  const h = hunks.find((x) => line >= x.newStart && line < x.newStart + Math.max(x.newLines, 1));
  return h?.id ?? null;
}

/** The hunk closest to a line outside every hunk: the one whose new-side
 *  range ends nearest to it, before or after. */
export function nearestHunk(hunks: Pick<Hunk, "id" | "newStart" | "newLines">[], line: number): string | null {
  let best: { id: string; d: number } | null = null;
  for (const h of hunks) {
    const end = h.newStart + Math.max(h.newLines, 1) - 1;
    const d = line < h.newStart ? h.newStart - line : Math.max(0, line - end);
    if (!best || d < best.d) best = { id: h.id, d };
  }
  return best?.id ?? null;
}

/** Unit ids, for the linker's exact-match lookup. */
export const unitIdSet = (units: Pick<ReviewUnit, "id">[]) => new Set(units.map((u) => u.id));

/** A hunk id of the current revision, to the file and first new-side line it opens at. */
export function hunkPlaces(files: Pick<FileEntry, "path" | "hunks">[]): Map<string, { path: string; line: number }> {
  const out = new Map<string, { path: string; line: number }>();
  for (const f of files) for (const h of f.hunks) out.set(h.id, { path: f.path, line: h.newStart });
  return out;
}

/**
 * The CodeLinkContext provider for one PR: code spans naming a unit id open
 * that unit and read as its number and title; spans naming a diff file (with
 * an optional line) open the file; a hunk id reads as `file.go:18` and opens
 * that hunk. Used by the chat and by the brief and
 * sidebar, where a ripple unit's summary names its driving unit by id.
 */
export function codeLinker(
  detail: PrDetail | undefined,
  open: { onOpenUnit?: (unitId: string) => void; onOpenFile?: (path: string, line?: number) => void },
): ((text: string) => CodeLink | null) | null {
  const { onOpenUnit, onOpenFile } = open;
  if (!detail || (!onOpenUnit && !onOpenFile)) return null;
  const units = new Map(detail.state.units.map((u) => [u.id, u]));
  const numbers = unitDisplayNumbers(detail.state.units);
  const ctx = { unitIds: onOpenUnit ? unitIdSet(detail.state.units) : new Set<string>(), files: detail.files.files };
  const hunks = onOpenFile ? hunkPlaces(detail.files.files) : new Map<string, { path: string; line: number }>();
  return (text: string): CodeLink | null => {
    const hunk = hunks.get(text.trim());
    if (hunk && onOpenFile) {
      const at = `${hunk.path.split("/").pop()}:${hunk.line}`;
      return {
        title: `Hunk at ${hunk.path}, line ${hunk.line}`,
        code: at,
        onOpen: () => onOpenFile(hunk.path, hunk.line),
      };
    }
    const target = resolveCodeTarget(text, ctx);
    if (target?.kind === "unit" && onOpenUnit) {
      const unit = units.get(target.unitId)!;
      const n = numbers.get(unit.id);
      const title = unit.title.replace(/`/g, "");
      return {
        title: `${n !== undefined ? `Unit ${n}` : "Unit"}: ${title}`,
        label: { number: n, text: title },
        onOpen: () => onOpenUnit(unit.id),
      };
    }
    if (target?.kind === "file" && onOpenFile) {
      return {
        title: target.line !== undefined ? `${target.path}, line ${target.line}` : target.path,
        onOpen: () => onOpenFile(target.path, target.line),
      };
    }
    return null;
  };
}
