/**
 * What a change is made of, in lines: implementation, tests, docs, generated.
 * Mechanical, from the same facts as the hunk hints, so it reads the same on
 * every PR, analyzed or not. It answers how much of a diff is the real change.
 */

import type { FileEntry, Hunk } from "../api/types";
import { fileHint, hunkHint, type HunkHint } from "./hunkHints";

export type ChangeKind = "implementation" | "tests" | "docs" | "generated";

export interface ChangeRow {
  kind: ChangeKind;
  added: number;
  removed: number;
  /** its share of the changed lines, 0 to 100 */
  percent: number;
}

export interface ChangeMix {
  /** only the kinds with lines, in CHANGE_KINDS order */
  rows: ChangeRow[];
  added: number;
  removed: number;
}

export const CHANGE_KINDS: ChangeKind[] = ["implementation", "tests", "docs", "generated"];

const KIND_OF_HINT: Record<HunkHint, ChangeKind> = {
  tests: "tests",
  snapshot: "tests",
  docs: "docs",
  generated: "generated",
  lockfile: "generated",
  migration: "implementation",
  "imports only": "implementation",
};

const kindOf = (hint: HunkHint | null): ChangeKind => (hint ? KIND_OF_HINT[hint] : "implementation");
const addedIn = (h: Hunk) => h.addedLines?.length ?? (h.lines ?? []).filter((l) => l.startsWith("+")).length;
const removedIn = (h: Hunk) => h.removedLines?.length ?? (h.lines ?? []).filter((l) => l.startsWith("-")).length;

/**
 * The mix of a whole PR, or of the hunks in `only`. For a whole PR a file's own
 * count covers lines no hunk holds (a patch too big for GitHub to send), and
 * those lines go by what the file is.
 */
export function changeMix(files: readonly FileEntry[], only?: ReadonlySet<string>): ChangeMix {
  const lines = new Map<ChangeKind, { added: number; removed: number }>(CHANGE_KINDS.map((k) => [k, { added: 0, removed: 0 }]));
  for (const file of files) {
    let added = 0;
    let removed = 0;
    for (const hunk of file.hunks) {
      if (only && !only.has(hunk.id)) continue;
      const row = lines.get(kindOf(hunkHint(file, hunk)))!;
      row.added += addedIn(hunk);
      row.removed += removedIn(hunk);
      added += addedIn(hunk);
      removed += removedIn(hunk);
    }
    if (only) continue;
    const rest = lines.get(kindOf(fileHint(file)))!;
    rest.added += Math.max(0, (file.additions ?? added) - added);
    rest.removed += Math.max(0, (file.deletions ?? removed) - removed);
  }
  const counted = [...lines.entries()];
  const added = counted.reduce((n, [, l]) => n + l.added, 0);
  const removed = counted.reduce((n, [, l]) => n + l.removed, 0);
  const total = added + removed;
  return {
    rows: counted
      .filter(([, l]) => l.added + l.removed > 0)
      .map(([kind, l]) => ({ kind, ...l, percent: (100 * (l.added + l.removed)) / total })),
    added,
    removed,
  };
}

/** "20%", and "<1%" rather than a 0% that has lines in it. */
export function formatShare(percent: number): string {
  return percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`;
}
