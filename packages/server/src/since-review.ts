import { readFilesJson, type PrKey, type State } from "@reviewer/core";

/**
 * "Since your last review": the hunks of the current revision that were not
 * in the revision the reader's last submitted review was on. Hunk ids hash a
 * hunk's added and removed lines (context excluded), so an id missing from
 * the reviewed revision is exactly a hunk that changed or appeared after it;
 * a rebase that leaves the PR's own lines alone flags nothing.
 */
export interface SinceReview {
  revision: number;
  ts: string;
  event: string;
  url?: string;
  changedHunkIds: string[];
}

/** `null` when nothing was submitted, the PR has not moved since, or that revision is gone. */
export function sinceLastReview(
  key: PrKey,
  state: Pick<State, "currentRevision" | "reviewSubmissions">,
  currentFiles: { hunks: { id: string }[] }[],
  root: string,
): SinceReview | null {
  const last = state.reviewSubmissions?.at(-1);
  if (!last || last.revision >= state.currentRevision) return null;
  let reviewed: Set<string>;
  try {
    reviewed = new Set(readFilesJson(key, last.revision, root).files.flatMap((f) => f.hunks.map((h) => h.id)));
  } catch {
    // The reviewed revision was discarded: nothing to compare against.
    return null;
  }
  const changedHunkIds = currentFiles.flatMap((f) => f.hunks.map((h) => h.id)).filter((id) => !reviewed.has(id));
  return { revision: last.revision, ts: last.ts, event: last.event, url: last.url, changedHunkIds };
}
