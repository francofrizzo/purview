import type { FileNotes } from "../api/types";

/** A file's note, or the nearest folder's above it. */
export function noteFor(notes: FileNotes | undefined, path: string): string | undefined {
  if (!notes) return undefined;
  for (let at = path; at; at = at.includes("/") ? at.slice(0, at.lastIndexOf("/")) : "") {
    if (notes[at] !== undefined) return notes[at];
  }
  return undefined;
}
