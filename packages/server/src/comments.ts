import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  computeHunkId,
  disambiguate,
  gh,
  loadState,
  prDir,
  readFilesJson,
  stateRoot,
  type FileDiff,
  type Hunk,
  type PrKey,
} from "@reviewer/core";

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

/**
 * What the comment is attached to. GitHub calls this `subject_type` and models
 * the same two cases: a diff line, or the file as a whole. It is an explicit
 * discriminator rather than "line is absent -> file-level" so that a malformed
 * line comment can be rejected instead of silently becoming a file comment.
 */
export const CommentSubjectTypeSchema = z.enum(["line", "file"]);
export type CommentSubjectType = z.infer<typeof CommentSubjectTypeSchema>;

/**
 * The stored/exposed shape *without* the subject invariant, so `.pick`/`.omit`
 * stay available (a refined schema is a ZodEffects and loses them). Everything
 * that validates rather than merely types goes through `subjectInvariant`.
 */
const CommentObjectSchema = z.object({
  id: z.string(),
  file: z.string(),
  subjectType: CommentSubjectTypeSchema,
  /** Absent on file-level comments. */
  line: z.number().int().optional(),
  /** Absent on file-level comments. */
  side: CommentSideSchema.optional(),
  body: z.string().min(1),
  createdAt: z.string(),
  status: CommentStatusSchema,
  /**
   * REST id (databaseId) of the review comment on GitHub. Used by the REST
   * delete endpoint (`DELETE /pulls/comments/{id}`), which takes databaseId.
   */
  githubCommentId: z.number().int().optional(),
  /**
   * GraphQL node id of the *comment itself* (not the thread). Distinct from
   * `githubCommentId` — GraphQL mutations that take a comment id (e.g.
   * `updatePullRequestReviewComment`) want this opaque node id, not the REST
   * databaseId; sending the databaseId there fails against real GitHub.
   */
  githubCommentNodeId: z.string().optional(),
  /** GraphQL node id of the thread, when the comment was appended via GraphQL. */
  githubThreadId: z.string().optional(),
  pushedAt: z.string().optional(),
  submittedAt: z.string().optional(),
  /** Set whenever the body is edited after creation. Absent on untouched comments. */
  updatedAt: z.string().optional(),
});

/** `subjectType` decides which of `line`/`side` are legal — both, or neither. */
function subjectInvariant(
  v: { subjectType: CommentSubjectType; line?: number; side?: CommentSide },
  ctx: z.RefinementCtx,
): void {
  if (v.subjectType === "file") {
    if (v.line !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["line"],
        message: "A file-level comment must not carry a line",
      });
    }
    if (v.side !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["side"],
        message: "A file-level comment must not carry a side",
      });
    }
    return;
  }
  if (v.line === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["line"],
      message: "A line comment requires a line",
    });
  }
  if (v.side === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["side"],
      message: "A line comment requires a side (LEFT or RIGHT)",
    });
  }
}

export const CommentSchema = CommentObjectSchema.superRefine(subjectInvariant);
export type Comment = z.infer<typeof CommentObjectSchema>;

/** Narrow helper for the many call sites that only care about the two cases. */
export function isFileLevel(c: Pick<Comment, "subjectType">): boolean {
  return c.subjectType === "file";
}

/**
 * What's actually on disk may predate the three-state vocabulary, where
 * "submitted" meant "pushed into a pending review" — and may predate
 * `subjectType` entirely. Parse loosely, then normalize. `submittedAt` is the
 * status discriminator: only a genuine submit (which always stamps it) keeps
 * the "submitted" status through a read.
 */
const StoredCommentSchema = CommentObjectSchema.omit({
  status: true,
  subjectType: true,
}).extend({
  status: z.string(),
  /** Absent in every comments.json written before file-level comments existed. */
  subjectType: CommentSubjectTypeSchema.optional(),
});

/**
 * Creation input. `subjectType` may be omitted, in which case it is inferred
 * from the presence of `line` — so the pre-existing `{file, line, side, body}`
 * body keeps working unchanged, and `{file, body}` means "the whole file".
 * An explicit `subjectType` is authoritative and is validated against the
 * other fields rather than quietly overridden.
 */
export const NewCommentSchema = z
  .object({
    file: z.string().min(1),
    subjectType: CommentSubjectTypeSchema.optional(),
    line: z.number().int().optional(),
    side: CommentSideSchema.optional(),
    body: z.string().min(1),
  })
  .transform((v) => ({
    ...v,
    subjectType: v.subjectType ?? (v.line === undefined ? ("file" as const) : ("line" as const)),
  }))
  .superRefine(subjectInvariant);
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

  // Migration: comments written before file-level support have no
  // `subjectType` but always have a `line`, so "has a line" is the safe
  // reading. A stored comment that claims to be a line comment yet carries no
  // line is unrepresentable — degrade it to file-level rather than throwing
  // and taking the whole file down.
  const subjectType: CommentSubjectType =
    raw.subjectType === "file" || raw.line === undefined ? "file" : "line";
  if (subjectType === "file") {
    const { line: _line, side: _side, ...rest } = raw;
    return { ...rest, subjectType, status };
  }
  return { ...raw, subjectType, line: raw.line, side: raw.side ?? "RIGHT", status };
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

export interface UpdateCommentPositionResult {
  found: boolean;
  /** false when the patch is a no-op (same line/file as stored) */
  changed: boolean;
  comment?: Comment;
}

/**
 * Local-only re-anchor of a draft comment's position, used both by the
 * "Suggest new anchor" apply step and by a reader manually dragging a comment
 * onto the right line. Callers are responsible for the draft-only and
 * in-diff invariants (the route validates against the current diff before
 * calling this) — this just moves the pointer and persists it.
 */
export function updateCommentPosition(
  key: PrKey,
  id: string,
  patch: { line?: number; file?: string },
  root = stateRoot(),
): UpdateCommentPositionResult {
  const comments = readComments(key, root);
  const idx = comments.findIndex((c) => c.id === id);
  if (idx === -1) return { found: false, changed: false };
  const target = comments[idx];
  const line = patch.line ?? target.line;
  const file = patch.file ?? target.file;
  if (line === target.line && file === target.file) {
    return { found: true, changed: false, comment: target };
  }
  const updated: Comment = { ...target, line, file };
  const next = [...comments];
  next[idx] = updated;
  writeComments(key, next, root);
  return { found: true, changed: true, comment: updated };
}

/** Mark comments as living in the pending review on GitHub. */
export function markPushed(
  key: PrKey,
  updates: {
    id: string;
    githubCommentId?: number;
    githubCommentNodeId?: string;
    githubThreadId?: string;
  }[],
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
        githubCommentNodeId: u.githubCommentNodeId ?? c.githubCommentNodeId,
        githubThreadId: u.githubThreadId ?? c.githubThreadId,
      };
    }),
    root,
  );
}

/** Persist a recovered GraphQL node id for a comment without touching anything else. */
export function setCommentNodeId(
  key: PrKey,
  id: string,
  githubCommentNodeId: string,
  root = stateRoot(),
): void {
  const comments = readComments(key, root);
  const idx = comments.findIndex((c) => c.id === id);
  if (idx === -1) return;
  const next = [...comments];
  next[idx] = { ...next[idx], githubCommentNodeId };
  writeComments(key, next, root);
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
    const { githubCommentId, githubCommentNodeId, githubThreadId, pushedAt, ...rest } = c;
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

/*
 * ------------------------------------------------------------- re-anchoring
 *
 * Draft comments are stored with an absolute file+line+side (see the module
 * doc comment above): unlike hunk *viewed state*, which core migrates across
 * revisions by content-derived hunk id (packages/core/src/migration.ts),
 * nothing re-anchors a draft when the PR gains a revision and the commented
 * line slides. A content-identical hunk keeps the same id across revisions
 * (packages/core/src/hunk-id.ts), so a within-hunk offset carries over
 * exactly — that's the fact this whole section leans on.
 */

/** Does `line` (on `side`) fall inside this hunk, in the revision it belongs to? */
function hunkAnchorsLine(hunk: Hunk, line: number, side: CommentSide): boolean {
  if (side === "RIGHT") {
    return hunk.newLines > 0 && line >= hunk.newStart && line < hunk.newStart + hunk.newLines;
  }
  return hunk.oldLines > 0 && line >= hunk.oldStart && line < hunk.oldStart + hunk.oldLines;
}

/** The hunk (if any) that anchors `file:line` on `side`, in a given revision's files. */
export function findAnchoringHunk(
  files: FileDiff[],
  file: string,
  line: number,
  side: CommentSide,
): Hunk | undefined {
  const f = files.find((f) => f.path === file);
  if (!f) return undefined;
  return f.hunks.find((h) => hunkAnchorsLine(h, line, side));
}

/**
 * id -> hunk+file for a revision's files, indexed under *both* the hunk's
 * actual id and — for a renamed file — the id it would have had under its
 * previous path. A hunk id bakes in the file path (hunk-id.ts), so a rename
 * alone changes every one of its hunks' ids even when the content is
 * unchanged; this recomputes what the id used to be so a hunk carried over
 * from before the rename is still reachable by its old id. Mirrors
 * migration.ts's `indexNew`, which solves the identical problem there.
 */
function indexByIdRenameAware(files: FileDiff[]): Map<string, { hunk: Hunk; file: string }> {
  const out = new Map<string, { hunk: Hunk; file: string }>();
  for (const f of files) {
    const matchPath = f.oldPath ?? f.path;
    const renamed = matchPath !== f.path;
    const seen = new Map<string, number>();
    for (const h of f.hunks) {
      out.set(h.id, { hunk: h, file: f.path });
      if (renamed) {
        const matchId = disambiguate(computeHunkId(matchPath, h.addedLines, h.removedLines), seen);
        out.set(matchId, { hunk: h, file: f.path });
      }
    }
  }
  return out;
}

export interface DraftCommentMove {
  id: string;
  file: string;
  fromLine: number;
  toLine: number;
  /** set only when the anchoring hunk now lives under a different path (rename) */
  toFile?: string;
}

/**
 * Re-anchor draft line comments that fell outside the diff when the PR moved
 * to a new revision.
 *
 * A comment that still anchors in the current revision is left alone. One
 * that doesn't is looked up in every prior revision, newest first: the first
 * one where it *did* anchor gives us the hunk it was resting on. That hunk's
 * id is then looked up in the current revision (identical id => identical
 * added/removed lines, so the offset from the hunk's start transfers exactly)
 * — if found, the comment's line (and file, under a rename) is updated to the
 * same offset within the current hunk. If the id isn't found in the current
 * revision either (the hunk itself changed or vanished), the comment is left
 * untouched — there's nothing safe to do deterministically; see the agentic
 * fallback (`comment-reanchor.ts`) for that case.
 *
 * Best-effort by construction: any read failure (missing files.json for an
 * intermediate revision, etc.) just makes that revision unavailable to search,
 * never throws.
 */
export function reanchorDraftComments(key: PrKey, root = stateRoot()): DraftCommentMove[] {
  const comments = readComments(key, root);
  const drafts = comments.filter((c) => c.status === "draft" && c.subjectType === "line");
  if (drafts.length === 0) return [];

  const state = loadState(key, root);
  const currentRevision = state.currentRevision;
  const currentFiles = readFilesJson(key, currentRevision, root).files;

  const currentById = indexByIdRenameAware(currentFiles);

  const moves: DraftCommentMove[] = [];
  const byId = new Map(comments.map((c) => [c.id, c]));

  for (const draft of drafts) {
    const line = draft.line!;
    const side = draft.side!;
    if (findAnchoringHunk(currentFiles, draft.file, line, side)) continue;

    let anchoringHunk: Hunk | undefined;
    for (let rev = currentRevision - 1; rev >= 1; rev--) {
      let files: FileDiff[];
      try {
        files = readFilesJson(key, rev, root).files;
      } catch {
        continue; // no files.json for this revision — tolerate and keep looking
      }
      const hunk = findAnchoringHunk(files, draft.file, line, side);
      if (hunk) {
        anchoringHunk = hunk;
        break;
      }
    }
    if (!anchoringHunk) continue; // never anchored anywhere we can see — leave it

    const current = currentById.get(anchoringHunk.id);
    if (!current) continue; // the hunk itself is gone from the current revision

    const toLine =
      side === "RIGHT"
        ? line - anchoringHunk.newStart + current.hunk.newStart
        : line - anchoringHunk.oldStart + current.hunk.oldStart;
    const toFile = current.file !== draft.file ? current.file : undefined;

    byId.set(draft.id, { ...draft, line: toLine, file: toFile ?? draft.file });
    moves.push({ id: draft.id, file: draft.file, fromLine: line, toLine, toFile });
  }

  if (moves.length > 0) {
    writeComments(key, comments.map((c) => byId.get(c.id) ?? c), root);
  }
  return moves;
}

/**
 * Draft line comments that don't anchor into the current revision's diff —
 * what `reanchorDraftComments` couldn't fix deterministically. Used to fail a
 * push before GitHub 422s on it (see comment-sync.ts). Never throws: if the
 * current revision's files can't be read, validation can't say anything
 * useful, so it reports nothing wrong rather than blocking the push.
 */
export function unanchoredDraftLineComments(key: PrKey, root = stateRoot()): Comment[] {
  const comments = readComments(key, root);
  const drafts = comments.filter((c) => c.status === "draft" && c.subjectType === "line");
  if (drafts.length === 0) return [];
  let currentFiles: FileDiff[];
  try {
    const state = loadState(key, root);
    currentFiles = readFilesJson(key, state.currentRevision, root).files;
  } catch {
    return [];
  }
  return drafts.filter((c) => !findAnchoringHunk(currentFiles, c.file, c.line!, c.side!));
}
