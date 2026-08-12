import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { prDir, stateRoot, type PrKey } from "@reviewer/core";

/**
 * `review.json` — the local review draft plus our memory of the pending review
 * on GitHub. Like comments.json this is a scratchpad rather than event-sourced
 * state: everything in it is either user-editable text or a cache of a remote
 * id that can be re-derived by listing the PR's reviews. The one durable
 * record of a finished review is the `review-submitted` event in core's log.
 */
export const ReviewDraftSchema = z.object({
  body: z.string().default(""),
  /** GraphQL node id of the viewer's pending review */
  pendingReviewId: z.string().optional(),
  /** REST id of the same review */
  pendingReviewDatabaseId: z.number().int().optional(),
  lastSyncedAt: z.string().optional(),
  submittedAt: z.string().optional(),
  submittedEvent: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]).optional(),
  submittedUrl: z.string().optional(),
});
export type ReviewDraft = z.infer<typeof ReviewDraftSchema>;

export function reviewPath(key: PrKey, root = stateRoot()): string {
  return path.join(prDir(key, root), "review.json");
}

export function readReviewDraft(key: PrKey, root = stateRoot()): ReviewDraft {
  const file = reviewPath(key, root);
  if (!fs.existsSync(file)) return ReviewDraftSchema.parse({});
  try {
    return ReviewDraftSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    // A corrupt scratchpad must not brick the PR view.
    return ReviewDraftSchema.parse({});
  }
}

export function writeReviewDraft(key: PrKey, draft: ReviewDraft, root = stateRoot()): ReviewDraft {
  const parsed = ReviewDraftSchema.parse(draft);
  const file = reviewPath(key, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  return parsed;
}

export function patchReviewDraft(
  key: PrKey,
  patch: Partial<ReviewDraft>,
  root = stateRoot(),
): ReviewDraft {
  return writeReviewDraft(key, { ...readReviewDraft(key, root), ...patch }, root);
}

/** Forget the pending review (it was submitted, discarded, or vanished). */
export function clearPendingReview(key: PrKey, root = stateRoot()): ReviewDraft {
  const current = readReviewDraft(key, root);
  const { pendingReviewId, pendingReviewDatabaseId, ...rest } = current;
  return writeReviewDraft(key, rest, root);
}
