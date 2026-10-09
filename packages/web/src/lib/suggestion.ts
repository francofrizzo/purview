/**
 * GitHub's "suggest a change": a ```suggestion fence in a line comment whose
 * body replaces the commented lines when the author applies it. This is the
 * pure side — what goes in the fence, where it goes in the text, and which
 * lines of the diff it stands for. Applying one is GitHub's job, not ours.
 */

import { isFileComment, type FilesJson } from "../api/types";
import { firstLine } from "./comments";
import { buildRows } from "./diffModel";
import type { Selection, TextEdit } from "./composerFormat";

/** What a comment points at, as far as a suggestion is concerned. */
export interface SuggestionAnchor {
  file: string;
  line?: number | null;
  side?: "LEFT" | "RIGHT" | null;
  startLine?: number | null;
  subjectType?: "line" | "file";
}

/**
 * Whether a suggestion can be written here. `lines` is the code it would
 * start from (the covered lines, as they read on the new side); `reason`
 * is why not, worded for the disabled button's tooltip.
 */
export type SuggestionSource = { lines: string[]; reason: null } | { lines: null; reason: string };

export const SUGGESTION_FENCE_INFO = "suggestion";

/**
 * The fence around `lines`. A line that itself holds a run of backticks would
 * close a three-backtick fence early, so the fence is one longer than the
 * longest run inside (CommonMark lets a fence be any length ≥ 3).
 */
export function suggestionBlock(lines: string[]): string {
  let longest = 2;
  for (const line of lines) {
    for (const run of line.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  }
  const fence = "`".repeat(longest + 1);
  return `${fence}${SUGGESTION_FENCE_INFO}\n${lines.join("\n")}\n${fence}`;
}

/**
 * Put a suggestion block in at the selection, on lines of its own, with the
 * code selected so typing replaces it. A second block after the first is
 * fine: GitHub accepts several per comment.
 */
export function insertSuggestion(text: string, sel: Selection, lines: string[]): TextEdit {
  const start = Math.min(sel.start, sel.end);
  const end = Math.max(sel.start, sel.end);
  const before = text.slice(0, start);
  const after = text.slice(end);
  const lead = before === "" || before.endsWith("\n") ? "" : "\n";
  const tail = after.startsWith("\n") ? "" : "\n";
  const block = suggestionBlock(lines);
  const code = lines.join("\n");
  const codeAt = start + lead.length + block.indexOf("\n") + 1;
  return {
    text: before + lead + block + tail + after,
    start: codeAt,
    end: codeAt + code.length,
  };
}

/**
 * The text of the lines a comment covers, as the diff shows them on the
 * comment's side, without the +/- marker. Null when no hunk of the current
 * diff holds the whole range (a stale comment, or one straddling two hunks).
 */
export function anchoredLines(files: FilesJson, anchor: SuggestionAnchor, diff = ""): string[] | null {
  if (isFileComment(anchor) || anchor.line === null || anchor.line === undefined) return null;
  const file = files.files.find((f) => f.path === anchor.file);
  if (!file) return null;
  const first = firstLine(anchor) as number;
  const last = anchor.line;
  for (const hunk of file.hunks) {
    const rows = buildRows(hunk, diff);
    const number = (r: (typeof rows)[number]) => (anchor.side === "LEFT" ? r.oldNumber : r.newNumber);
    const from = rows.findIndex((r) => number(r) === first);
    const to = rows.findIndex((r) => number(r) === last);
    if (from === -1 || to === -1 || to < from) continue;
    // Only this side's rows: the other side's lines sit between them in a hunk.
    return rows.slice(from, to + 1).filter((r) => number(r) !== undefined).map((r) => r.content);
  }
  return null;
}

/**
 * Can a suggestion be written on this comment, and from what code? GitHub
 * takes them only on the new side of the diff, on lines the diff shows.
 */
export function suggestionSource(files: FilesJson | undefined, anchor: SuggestionAnchor, diff?: string): SuggestionSource {
  if (isFileComment(anchor) || anchor.line === null || anchor.line === undefined) {
    return { lines: null, reason: "Suggestions need a line: this comment is on the whole file" };
  }
  if (anchor.side === "LEFT") {
    return { lines: null, reason: "GitHub only takes suggestions on the new side of the diff" };
  }
  const lines = files ? anchoredLines(files, anchor, diff) : null;
  if (!lines) return { lines: null, reason: "These lines are not in the current diff, so there is nothing to suggest over" };
  return { lines, reason: null };
}
