import { diffLines, diffWordsWithSpace } from "diff";
import type { Hunk } from "./schemas.js";

export interface WordPart {
  value: string;
  type: "same" | "added" | "removed";
}

export interface DiffOfDiffsLine {
  type: "unchanged" | "added" | "removed" | "modified";
  oldLine?: string;
  newLine?: string;
  /** word-level breakdown, only for `modified` lines */
  parts?: WordPart[];
}

export interface DiffOfDiffs {
  lines: DiffOfDiffsLine[];
  changed: boolean;
}

function splitLines(text: string): string[] {
  const t = text.endsWith("\n") ? text.slice(0, -1) : text;
  return t.length === 0 ? [] : t.split("\n");
}

function wordParts(oldLine: string, newLine: string): WordPart[] {
  return diffWordsWithSpace(oldLine, newLine).map((p) => ({
    value: p.value,
    type: p.added ? "added" : p.removed ? "removed" : "same",
  }));
}

/**
 * Word-level "diff of diffs": how the *content of a hunk* changed between two
 * revisions. Feed it the two hunks' raw bodies (`hunk.text`).
 */
export function diffOfDiffs(oldText: string, newText: string): DiffOfDiffs {
  const parts = diffLines(
    oldText.endsWith("\n") ? oldText : oldText + "\n",
    newText.endsWith("\n") ? newText : newText + "\n",
  );

  const lines: DiffOfDiffsLine[] = [];
  let i = 0;
  while (i < parts.length) {
    const p = parts[i];
    if (!p.added && !p.removed) {
      for (const l of splitLines(p.value)) lines.push({ type: "unchanged", oldLine: l, newLine: l });
      i++;
      continue;
    }
    // Pair a removed block with an immediately following added block so that
    // edits render as word-level `modified` lines instead of remove+add.
    const removed = p.removed ? splitLines(p.value) : [];
    let added: string[] = [];
    if (p.removed && parts[i + 1]?.added) {
      added = splitLines(parts[i + 1].value);
      i += 2;
    } else if (p.added) {
      added = splitLines(p.value);
      i++;
    } else {
      i++;
    }
    const n = Math.max(removed.length, added.length);
    for (let k = 0; k < n; k++) {
      const o = removed[k];
      const a = added[k];
      if (o !== undefined && a !== undefined) {
        lines.push({
          type: "modified",
          oldLine: o,
          newLine: a,
          parts: wordParts(o, a),
        });
      } else if (o !== undefined) {
        lines.push({ type: "removed", oldLine: o });
      } else if (a !== undefined) {
        lines.push({ type: "added", newLine: a });
      }
    }
  }

  return { lines, changed: lines.some((l) => l.type !== "unchanged") };
}

/** Convenience wrapper for two parsed hunks. */
export function hunkDiffOfDiffs(oldHunk: Hunk, newHunk: Hunk): DiffOfDiffs {
  return diffOfDiffs(oldHunk.text, newHunk.text);
}
