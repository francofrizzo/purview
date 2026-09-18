import type { FilesJson } from "../api/types";

/**
 * One rough shape per definition a common language uses, matched against a
 * diff's added lines: group 1 must capture the defined identifier. Not a
 * parser — no attempt is made to be exact — it exists purely to answer
 * "does this diff define that name," so a miss just means no affordance
 * rather than a wrong jump.
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
 * Every definition the PR itself introduces, scanned once per diff and keyed
 * by the defined identifier (in document order — file, then hunk, then added
 * line). A symbol added by the PR (a new type, function, class...) does not
 * exist anywhere else — it is sitting right in these added lines — so this is
 * the whole of "go to definition" now: no server round-trip, no checkout to
 * search. `findDiffLocalDefinitions` is a lookup over this same index.
 */
export function buildDefinitionIndex(files: FilesJson): Map<string, DiffLocalDefinition[]> {
  const index = new Map<string, DiffLocalDefinition[]>();
  for (const file of files.files) {
    for (const hunk of file.hunks) {
      const added = hunk.addedLines ?? [];
      for (let i = 0; i < added.length; i++) {
        const line = added[i];
        for (const re of DEFINITION_LINE_PATTERNS) {
          const name = re.exec(line)?.[1];
          if (!name) continue;
          const def: DiffLocalDefinition = {
            hunkId: hunk.id,
            path: file.path,
            lineText: line.trim(),
            addedIndex: i,
          };
          const list = index.get(name);
          if (list) list.push(def);
          else index.set(name, [def]);
          break; // one pattern per line is enough — a line defines at most one name
        }
      }
    }
  }
  return index;
}

/** Thin lookup over {@link buildDefinitionIndex} for callers with a single symbol in hand. */
export function findDiffLocalDefinitions(files: FilesJson, symbol: string): DiffLocalDefinition[] {
  return buildDefinitionIndex(files).get(symbol) ?? [];
}
