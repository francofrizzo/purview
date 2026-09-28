/**
 * What a code span in a chat reply points at, if anything the PR view can
 * open. The model already writes units as `unit-id` and places as
 * `path/to/file.go:23` (or `file.go:~551-567`, `file.go`), so these are read
 * straight from what it writes rather than taught a link syntax.
 */

import type { FileEntry, Hunk, ReviewUnit } from "../api/types";

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
