import { createHash } from "node:crypto";

/**
 * hunkId = sha256( normalizedPath + "\0" + addedLines.join("\n") + "\0" +
 *                  removedLines.join("\n") ).slice(0, 16)
 *
 * Context lines are excluded; added/removed lines carry no `+`/`-` marker.
 * `normalizedPath` is the new path, or the old path when the file was deleted.
 */
export function computeHunkId(
  normalizedPath: string,
  addedLines: string[],
  removedLines: string[],
): string {
  const payload =
    normalizedPath +
    "\0" +
    addedLines.join("\n") +
    "\0" +
    removedLines.join("\n");
  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 16);
}

/**
 * Disambiguate hunks that hash identically within the same file: the first
 * keeps the bare id, later ones get `#2`, `#3`, ... by order of appearance.
 */
export function disambiguate(baseId: string, seen: Map<string, number>): string {
  const n = (seen.get(baseId) ?? 0) + 1;
  seen.set(baseId, n);
  return n === 1 ? baseId : `${baseId}#${n}`;
}

/** Strip a `#2`/`#3` disambiguation suffix. */
export function baseHunkId(id: string): string {
  const i = id.indexOf("#");
  return i === -1 ? id : id.slice(0, i);
}
