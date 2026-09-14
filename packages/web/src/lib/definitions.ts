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
