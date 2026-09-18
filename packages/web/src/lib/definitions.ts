import type { FilesJson } from "../api/types";

/**
 * "Go to definition" in-diff mapping: is a definition candidate's location
 * already visible in the current diff? If so, DiffPane scrolls to it instead
 * of a popover opening — see PrView's use of this.
 */
export interface InDiffHunk {
  hunkId: string;
  path: string;
}

/**
 * A candidate is "in this diff" when its file is one of the changed files and
 * its line falls inside one of that file's hunks, on the *new*-file side
 * (`newStart`/`newLines` — the candidate's line number is read straight out
 * of the checkout's current file content, which lines up with the new side of
 * the diff, not the old one). A hunk with `newLines === 0` (a pure deletion)
 * can never contain a still-live definition, so it's skipped rather than
 * matching every line via a degenerate range.
 */
export function findInDiffHunk(files: FilesJson, path: string, line: number): InDiffHunk | null {
  for (const file of files.files) {
    if (file.path !== path) continue;
    for (const hunk of file.hunks) {
      if (hunk.newLines <= 0) continue;
      if (line >= hunk.newStart && line < hunk.newStart + hunk.newLines) {
        return { hunkId: hunk.id, path: file.path };
      }
    }
  }
  return null;
}

/**
 * Definition shapes for the diff-local scan below. MIRRORED PATTERNS — the
 * server keeps the authoritative list in packages/server/src/definitions.ts
 * (DEFINITION_GREP_PATTERNS); this is the same set as JS regexes, minus the
 * NAME placeholder: group 1 must capture the defined identifier. Change one
 * list, revisit the other.
 */
const DEFINITION_LINE_PATTERNS: RegExp[] = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/, // js/ts
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, // js/ts/java/c#/php
  /^\s*(?:export\s+)?(?:type|interface)\s+([A-Za-z_$][\w$]*)/, // ts
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/, // js/ts
  /^\s*def\s+([A-Za-z_]\w*)/, // python/ruby
  /^\s*class\s+([A-Za-z_]\w*)/, // python/ruby
  /^\s*func\s*(?:\([^)]*\))?\s*([A-Za-z_]\w*)/, // go (incl. method receivers)
  /^\s*type\s+([A-Za-z_]\w*)\s/, // go
  /^\s*fn\s+([A-Za-z_]\w*)/, // rust
  /^\s*struct\s+([A-Za-z_]\w*)/, // rust/c/c++
  /^\s*enum\s+([A-Za-z_]\w*)/, // rust/java/c#/c++
];

export interface DiffLocalDefinition {
  hunkId: string;
  path: string;
  /** the matched added line, trimmed — shown as the candidate's signature */
  lineText: string;
  /** index into the hunk's addedLines, so the diff pane can land on the row itself */
  addedIndex: number;
}

/**
 * Definitions the PR itself introduces. A symbol added by the PR (a new type,
 * function, class...) does not exist in the local checkout at all — no engine
 * on the server can ever find it — but its definition is sitting right in the
 * diff's added lines. Scanned client-side, first match per hunk document
 * order, before the server is even asked.
 */
export function findDiffLocalDefinitions(files: FilesJson, symbol: string): DiffLocalDefinition[] {
  const out: DiffLocalDefinition[] = [];
  for (const file of files.files) {
    for (const hunk of file.hunks) {
      const added = hunk.addedLines ?? [];
      for (let i = 0; i < added.length; i++) {
        const line = added[i];
        if (!line.includes(symbol)) continue;
        const matched = DEFINITION_LINE_PATTERNS.some((re) => re.exec(line)?.[1] === symbol);
        if (!matched) continue;
        out.push({ hunkId: hunk.id, path: file.path, lineText: line.trim(), addedIndex: i });
        break; // one hit per hunk is enough to jump to it
      }
    }
  }
  return out;
}
