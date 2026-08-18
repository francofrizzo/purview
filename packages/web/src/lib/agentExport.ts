/**
 * Rendering review comments as markdown a coding agent can act on.
 *
 * The output is a work order, not a transcript: every comment carries the
 * code it is about (sliced out of the diff, so the agent does not have to go
 * looking) and the reviewer's words as a blockquote under it. Pure functions
 * only — the UI owns the clipboard, this file owns the text.
 */

import type { CommentStatus, FilesJson, Hunk } from "../api/types";
import { buildRows, languageFor } from "./diffModel";

/** How much of the surrounding hunk travels with the anchored line. */
export const CONTEXT_LINES = 2;

/** The diff the comments are anchored into. */
export interface DiffContext {
  files: FilesJson;
  /** raw unified diff; only consulted for hunks that predate `hunk.lines` */
  diff?: string;
}

/**
 * The subset of a comment this module needs. Both `DraftComment` and the
 * `ReviewStatus.included` entries satisfy it, so callers never adapt.
 */
export interface ExportableComment {
  file: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
  status?: CommentStatus;
}

export interface BundleOptions {
  /** e.g. "acme/billing#482"; omitted → the bundle gets a generic heading */
  repoLabel?: string;
  revision?: number;
  /** the review body draft, used as a plain preamble paragraph */
  reviewBody?: string;
  /** include already-submitted comments (default: draft + pushed only) */
  includeSubmitted?: boolean;
}

export const STALE_NOTE = "(line no longer in current diff)";

/* ------------------------------------------------------------- selection */

/**
 * File path, then line. Stable enough that copying the same set twice yields
 * byte-identical text, which matters when the reader re-pastes after an edit.
 */
export function sortComments<T extends ExportableComment>(comments: T[]): T[] {
  return [...comments].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.side.localeCompare(b.side),
  );
}

/**
 * What a bundle carries: everything still in flight (draft + pushed), and
 * optionally the comments that already went public.
 */
export function selectForBundle<T extends ExportableComment>(
  comments: T[],
  includeSubmitted = false,
): T[] {
  const kept = comments.filter((c) => {
    const status = c.status ?? "draft";
    return status !== "submitted" || includeSubmitted;
  });
  return sortComments(kept);
}

/* --------------------------------------------------------------- snippet */

export interface Snippet {
  /** fence info string; "" when the extension is unknown */
  lang: string;
  /** already marker-adjusted: context bare, changed lines keep their +/- */
  lines: string[];
}

/**
 * The lines a comment anchors to: the hunk that contains the anchored line,
 * sliced to ±`CONTEXT_LINES` around it. `null` when no hunk in the current
 * revision still has that line — a stale comment.
 */
export function snippetFor(comment: ExportableComment, ctx: DiffContext): Snippet | null {
  const file = ctx.files.files.find((f) => f.path === comment.file);
  if (!file) return null;

  for (const hunk of file.hunks) {
    const found = sliceHunk(hunk, comment, ctx.diff ?? "");
    if (found) return { lang: languageFor(comment.file) ?? "", lines: found };
  }
  return null;
}

function sliceHunk(hunk: Hunk, comment: ExportableComment, diff: string): string[] | null {
  const rows = buildRows(hunk, diff);
  const number = (r: (typeof rows)[number]) =>
    comment.side === "LEFT" ? r.oldNumber : r.newNumber;
  const at = rows.findIndex((r) => number(r) === comment.line);
  if (at === -1) return null;

  // Clamped, not padded: a comment on the first line of a hunk gets whatever
  // context the hunk actually has, rather than blank filler.
  const from = Math.max(0, at - CONTEXT_LINES);
  const to = Math.min(rows.length, at + CONTEXT_LINES + 1);
  return rows.slice(from, to).map((r) => {
    if (r.type === "add") return `+${r.content}`;
    if (r.type === "del") return `-${r.content}`;
    return r.content;
  });
}

/* ---------------------------------------------------------------- render */

/** `> ` on every line, including the blank ones, so the quote stays one block. */
export function blockquote(body: string): string {
  return body
    .replace(/\s+$/, "")
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

function heading(comment: ExportableComment, index?: number): string {
  const side = comment.side === "LEFT" ? "old side" : "new side";
  const number = index === undefined ? "" : `${index}. `;
  return `### ${number}\`${comment.file}:${comment.line}\` (${side})`;
}

/**
 * One comment as a standalone block: heading, the code it points at, the
 * reviewer's words. `index` numbers it (bundles only).
 */
export function formatComment(
  comment: ExportableComment,
  ctx: DiffContext,
  index?: number,
): string {
  const parts: string[] = [heading(comment, index)];
  const snippet = snippetFor(comment, ctx);
  if (snippet) {
    parts.push(["```" + snippet.lang, ...snippet.lines, "```"].join("\n"));
  } else {
    parts.push(STALE_NOTE);
  }
  parts.push(blockquote(comment.body));
  return parts.join("\n");
}

/**
 * Every selected comment under one heading, numbered, with the review body
 * draft as the preamble. Returns "" when nothing is selected, so the UI can
 * refuse to copy an empty work order.
 */
export function formatBundle(
  comments: ExportableComment[],
  ctx: DiffContext,
  options: BundleOptions = {},
): string {
  const selected = selectForBundle(comments, options.includeSubmitted);
  if (selected.length === 0) return "";

  const target = options.repoLabel ? ` for ${options.repoLabel}` : "";
  const rev = options.revision === undefined ? "" : ` (rev ${options.revision})`;
  const blocks: string[] = [`## Review feedback${target}${rev}`];

  const preamble = (options.reviewBody ?? "").trim();
  if (preamble) blocks.push(preamble);

  selected.forEach((c, i) => blocks.push(formatComment(c, ctx, i + 1)));
  return blocks.join("\n\n") + "\n";
}

/** "acme/billing#482" from the PR meta the view already holds. */
export function repoLabel(meta: { owner: string; repo: string; number: number }): string {
  return `${meta.owner}/${meta.repo}#${meta.number}`;
}
