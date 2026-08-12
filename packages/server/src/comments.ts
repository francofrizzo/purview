import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { gh, prDir, stateRoot, type PrKey } from "@reviewer/core";

/**
 * Local draft comments. Core has no comments module (SPEC's state dir only
 * defines meta/events/state/revisions), so these live alongside it as
 * `comments.json` in the PR's state dir — same durability story, just not
 * folded from events since they're a push-only local scratchpad.
 */
export const CommentSideSchema = z.enum(["LEFT", "RIGHT"]);
export type CommentSide = z.infer<typeof CommentSideSchema>;

/**
 * Three states, not two:
 *   draft     — local only, never sent anywhere.
 *   pushed    — present in the viewer's PENDING review on GitHub. Visible to
 *               nobody but the reviewer; still deletable/discardable.
 *   submitted — the review carrying it was submitted; now public.
 */
export const CommentStatusSchema = z.enum(["draft", "pushed", "submitted"]);
export type CommentStatus = z.infer<typeof CommentStatusSchema>;

export const CommentSchema = z.object({
  id: z.string(),
  file: z.string(),
  line: z.number().int(),
  side: CommentSideSchema,
  body: z.string().min(1),
  createdAt: z.string(),
  status: CommentStatusSchema,
  /** REST id of the review comment on GitHub, when GitHub gave us one. */
  githubCommentId: z.number().int().optional(),
  /** GraphQL node id of the thread, when the comment was appended via GraphQL. */
  githubThreadId: z.string().optional(),
  pushedAt: z.string().optional(),
  submittedAt: z.string().optional(),
  /** Set whenever the body is edited after creation. Absent on untouched comments. */
  updatedAt: z.string().optional(),
});
export type Comment = z.infer<typeof CommentSchema>;

/**
 * What's actually on disk may predate the three-state vocabulary, where
 * "submitted" meant "pushed into a pending review". Parse loosely, then
 * normalize. `submittedAt` is the discriminator: only a genuine submit (which
 * always stamps it) keeps the "submitted" status through a read.
 */
const StoredCommentSchema = CommentSchema.omit({ status: true }).extend({
  status: z.string(),
});

export const NewCommentSchema = CommentSchema.pick({
  file: true,
  line: true,
  side: true,
  body: true,
});
export type NewComment = z.infer<typeof NewCommentSchema>;

function commentsPath(key: PrKey, root = stateRoot()): string {
  return path.join(prDir(key, root), "comments.json");
}

function normalize(raw: z.infer<typeof StoredCommentSchema>): Comment {
  let status: CommentStatus;
  if (raw.status === "submitted") {
    // Legacy value unless the submit path actually stamped a timestamp.
    status = raw.submittedAt ? "submitted" : "pushed";
  } else if (raw.status === "pushed") {
    status = "pushed";
  } else {
    status = "draft";
  }
  return { ...raw, status };
}

export function readComments(key: PrKey, root = stateRoot()): Comment[] {
  const file = commentsPath(key, root);
  if (!fs.existsSync(file)) return [];
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return z.array(StoredCommentSchema).parse(raw).map(normalize);
}

export function writeComments(key: PrKey, comments: Comment[], root = stateRoot()): void {
  const file = commentsPath(key, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(comments, null, 2) + "\n", "utf8");
}

export function addComment(key: PrKey, input: unknown, root = stateRoot()): Comment {
  const parsed = NewCommentSchema.parse(input);
  const comment: Comment = {
    id: randomUUID(),
    ...parsed,
    createdAt: new Date().toISOString(),
    status: "draft",
  };
  const comments = readComments(key, root);
  comments.push(comment);
  writeComments(key, comments, root);
  return comment;
}

export interface DeleteCommentResult {
  removed: boolean;
  /** set when we tried to remove it from GitHub too */
  remote?: { attempted: true; ok: boolean; error?: string };
}

function hostArgs(host: string): string[] {
  return host && host !== "github.com" ? ["--hostname", host] : [];
}

/**
 * Deleting a `pushed` comment should also remove it from the pending review on
 * GitHub, but a failure there must never fail the request: the local drafts
 * file is the source of truth, and a stale pending comment is recoverable (the
 * reader can discard the pending review). The remote outcome is reported, not
 * thrown.
 */
export function deleteComment(
  key: PrKey,
  id: string,
  root = stateRoot(),
): DeleteCommentResult {
  const comments = readComments(key, root);
  const target = comments.find((c) => c.id === id);
  if (!target) return { removed: false };

  let remote: DeleteCommentResult["remote"];
  // Only `pushed` comments are ours to retract: a `submitted` one is public
  // and deleting it silently on a local delete would be a surprise.
  if (target.status === "pushed" && target.githubCommentId !== undefined) {
    try {
      gh([
        "api",
        "--method",
        "DELETE",
        ...hostArgs(key.host),
        `repos/${key.owner}/${key.repo}/pulls/comments/${target.githubCommentId}`,
      ]);
      remote = { attempted: true, ok: true };
    } catch (err) {
      remote = {
        attempted: true,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  writeComments(
    key,
    comments.filter((c) => c.id !== id),
    root,
  );
  return { removed: true, remote };
}

export interface UpdateCommentBodyResult {
  found: boolean;
  /** false when the new body equals the stored one — caller should treat as a no-op. */
  changed: boolean;
  comment?: Comment;
}

/**
 * Local-only body edit. Whether/how to reflect the change on GitHub is a
 * routing decision that depends on the comment's status (draft/pushed/
 * submitted), so that lives in the route handler; this just updates the
 * source of truth on disk and reports whether anything actually changed, so
 * callers can skip remote work on a true no-op edit.
 */
export function updateCommentBody(
  key: PrKey,
  id: string,
  body: string,
  root = stateRoot(),
): UpdateCommentBodyResult {
  const comments = readComments(key, root);
  const idx = comments.findIndex((c) => c.id === id);
  if (idx === -1) return { found: false, changed: false };
  const target = comments[idx];
  if (target.body === body) {
    return { found: true, changed: false, comment: target };
  }
  const updated: Comment = { ...target, body, updatedAt: new Date().toISOString() };
  const next = [...comments];
  next[idx] = updated;
  writeComments(key, next, root);
  return { found: true, changed: true, comment: updated };
}

/** Mark comments as living in the pending review on GitHub. */
export function markPushed(
  key: PrKey,
  updates: { id: string; githubCommentId?: number; githubThreadId?: string }[],
  root = stateRoot(),
): void {
  if (updates.length === 0) return;
  const byId = new Map(updates.map((u) => [u.id, u]));
  const now = new Date().toISOString();
  writeComments(
    key,
    readComments(key, root).map((c) => {
      const u = byId.get(c.id);
      if (!u) return c;
      return {
        ...c,
        status: "pushed" as const,
        pushedAt: now,
        githubCommentId: u.githubCommentId ?? c.githubCommentId,
        githubThreadId: u.githubThreadId ?? c.githubThreadId,
      };
    }),
    root,
  );
}

/** The review went public: every pushed comment went with it. */
export function markSubmitted(key: PrKey, ids: string[], root = stateRoot()): void {
  if (ids.length === 0) return;
  const set = new Set(ids);
  const now = new Date().toISOString();
  writeComments(
    key,
    readComments(key, root).map((c) =>
      set.has(c.id) ? { ...c, status: "submitted" as const, submittedAt: now } : c,
    ),
    root,
  );
}

/**
 * The pending review was discarded on GitHub, so anything we had pushed into
 * it no longer exists remotely — it becomes a local draft again.
 */
export function resetPushedToDraft(key: PrKey, root = stateRoot()): number {
  const comments = readComments(key, root);
  let reset = 0;
  const next = comments.map((c) => {
    if (c.status !== "pushed") return c;
    reset += 1;
    const { githubCommentId, githubThreadId, pushedAt, ...rest } = c;
    return { ...rest, status: "draft" as const };
  });
  if (reset > 0) writeComments(key, next, root);
  return reset;
}

export function commentCounts(comments: Comment[]) {
  return {
    draft: comments.filter((c) => c.status === "draft").length,
    pushed: comments.filter((c) => c.status === "pushed").length,
    submitted: comments.filter((c) => c.status === "submitted").length,
  };
}
