/**
 * Pure formatting for the transient result line the "import review
 * requests…" action shows in a repo section after it finishes. Kept out of
 * the component so it's unit-testable without rendering anything.
 */

import type { ImportReviewsResult } from "../api/types";

export function formatImportResult(result: ImportReviewsResult): string {
  const parts = [`imported ${result.imported.length}`];
  const back = result.unarchived?.length ?? 0;
  if (back > 0) parts.push(`${back} back from the archive`);
  const tracked = result.alreadyTracked.length - back;
  if (tracked > 0) {
    parts.push(`${tracked} already tracked`);
  }
  if (result.failed.length > 0) {
    parts.push(`${result.failed.length} failed`);
  }
  return parts.join(" · ");
}
