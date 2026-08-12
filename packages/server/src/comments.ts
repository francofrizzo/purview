import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prDir, stateRoot, type PrKey } from "@reviewer/core";

/**
 * Local draft comments. Core has no comments module (SPEC's state dir only
 * defines meta/events/state/revisions), so these live alongside it as
 * `comments.json` in the PR's state dir — same durability story, just not
 * folded from events since they're a push-only local scratchpad.
 */
export const CommentSideSchema = z.enum(["LEFT", "RIGHT"]);
export type CommentSide = z.infer<typeof CommentSideSchema>;

export const CommentStatusSchema = z.enum(["draft", "submitted"]);
export type CommentStatus = z.infer<typeof CommentStatusSchema>;

export const CommentSchema = z.object({
  id: z.string(),
  file: z.string(),
  line: z.number().int(),
  side: CommentSideSchema,
  body: z.string().min(1),
  createdAt: z.string(),
  status: CommentStatusSchema,
});
export type Comment = z.infer<typeof CommentSchema>;

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

export function readComments(key: PrKey, root = stateRoot()): Comment[] {
  const file = commentsPath(key, root);
  if (!fs.existsSync(file)) return [];
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return z.array(CommentSchema).parse(raw);
}

function writeComments(key: PrKey, comments: Comment[], root = stateRoot()): void {
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

export function deleteComment(key: PrKey, id: string, root = stateRoot()): boolean {
  const comments = readComments(key, root);
  const next = comments.filter((c) => c.id !== id);
  if (next.length === comments.length) return false;
  writeComments(key, next, root);
  return true;
}

export function markSubmitted(key: PrKey, ids: string[], root = stateRoot()): void {
  if (ids.length === 0) return;
  const set = new Set(ids);
  const comments = readComments(key, root).map((c) =>
    set.has(c.id) ? { ...c, status: "submitted" as const } : c,
  );
  writeComments(key, comments, root);
}
