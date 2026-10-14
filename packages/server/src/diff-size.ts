import { keyToString, readFilesJson, stateRoot, type PrKey } from "@reviewer/core";

/**
 * The PR's size the way GitHub states it: files changed, lines added, lines
 * removed — for the PR list, which never opens files.json in the browser.
 * Per file, GitHub's own counts when files.json has them, else the hunks'
 * added/removed line arrays; a binary file counts as a file and nothing else.
 */
export interface DiffSize {
  files: number;
  additions: number;
  deletions: number;
}

export function sumDiffSize(
  files: readonly {
    additions?: number | null;
    deletions?: number | null;
    hunks?: readonly { addedLines?: readonly string[]; removedLines?: readonly string[] }[];
  }[],
): DiffSize {
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    if (typeof f.additions === "number" && typeof f.deletions === "number") {
      additions += f.additions;
      deletions += f.deletions;
      continue;
    }
    for (const h of f.hunks ?? []) {
      additions += h.addedLines?.length ?? 0;
      deletions += h.removedLines?.length ?? 0;
    }
  }
  return { files: files.length, additions, deletions };
}

// A revision's files.json never changes once written, so one read per
// (PR, revision) for the life of the process is enough.
const cache = new Map<string, DiffSize>();

export function clearDiffSizeCache(): void {
  cache.clear();
}

/** `null` when the revision has no files.json (not fetched yet, or pruned). */
export function diffSize(key: PrKey, revision: number | undefined, root = stateRoot()): DiffSize | null {
  if (revision === undefined) return null;
  const cacheKey = `${root}#${keyToString(key)}#${revision}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;
  try {
    const size = sumDiffSize(readFilesJson(key, revision, root).files);
    cache.set(cacheKey, size);
    return size;
  } catch {
    return null;
  }
}
