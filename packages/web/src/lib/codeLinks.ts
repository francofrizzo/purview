/**
 * What a code span in a chat reply points at, if anything the PR view can
 * open. The model already writes units as `unit-id` and places as
 * `path/to/file.go:23` (or `file.go:~551-567`, `file.go`), so these are read
 * straight from what it writes rather than taught a link syntax.
 */

import type { FileEntry, Hunk, PrDetail, ReviewUnit } from "../api/types";
import type { CodeLink } from "../components/Markdown";
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

/** The hunk showing `line` on the new side, if the diff shows it at all. */
export function hunkAtLine(
  hunks: Pick<Hunk, "id" | "newStart" | "newLines">[],
  line: number,
): string | null {
  const h = hunks.find((x) => line >= x.newStart && line < x.newStart + Math.max(x.newLines, 1));
  return h?.id ?? null;
}

/** Unit ids, for the linker's exact-match lookup. */
export const unitIdSet = (units: Pick<ReviewUnit, "id">[]) => new Set(units.map((u) => u.id));

/**
 * The CodeLinkContext provider for one PR: code spans naming a unit id open
 * that unit and read as its number and title; spans naming a diff file (with
 * an optional line) open the file. Used by the chat and by the brief and
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
  return (text: string): CodeLink | null => {
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
