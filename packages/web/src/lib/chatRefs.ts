/**
 * The ref model behind the chat panel's chips.
 *
 * A ref is a pointer into the review (a unit, a hunk, a file, a range of lines,
 * a comment). Everything here is pure: identity for dedup, the attach/detach
 * reducer the panel drives, and the compact label a chip shows. The label needs
 * more than the ref itself — a unit is worth showing by title, not by id — so
 * callers pass a small lookup context assembled from the loaded PR.
 */

import type { ChatRef, DraftComment, FileEntry, Hunk, PrDetail, ReviewUnit } from "../api/types";

/** Stable identity of a ref: two refs with the same key are the same pointer. */
export function refKey(ref: ChatRef): string {
  switch (ref.kind) {
    case "unit":
    case "comment":
      return `${ref.kind}:${ref.id ?? ""}`;
    case "hunk":
      return `hunk:${ref.id ?? ""}`;
    case "file":
      return `file:${ref.path ?? ""}`;
    case "line-range":
      return `lines:${ref.path ?? ""}:${ref.side ?? "new"}:${ref.start ?? ""}-${ref.end ?? ""}`;
    default:
      return JSON.stringify(ref);
  }
}

/**
 * Attach a ref. Attaching the same pointer twice is a no-op that keeps the
 * original position, so re-quoting something already attached never reorders
 * the chips under the reader's cursor.
 */
export function addRef(refs: ChatRef[], ref: ChatRef): ChatRef[] {
  const key = refKey(ref);
  if (refs.some((r) => refKey(r) === key)) return refs;
  return [...refs, ref];
}

export function removeRef(refs: ChatRef[], key: string): ChatRef[] {
  const next = refs.filter((r) => refKey(r) !== key);
  return next.length === refs.length ? refs : next;
}

/** Normalize a line range so start <= end regardless of drag direction. */
export function lineRangeRef(
  path: string,
  side: "old" | "new",
  a: number,
  b: number,
): ChatRef {
  return { kind: "line-range", path, side, start: Math.min(a, b), end: Math.max(a, b) };
}

export interface RefLabelContext {
  unitTitle?: (id: string) => string | undefined;
  hunk?: (id: string) => { file: string; oldStart: number; oldLines: number; newStart: number; newLines: number } | undefined;
  comment?: (id: string) => { file: string; line: number } | undefined;
}

/** The file's basename — chips are narrow, and the directory is rarely the point. */
export function baseName(path: string): string {
  const base = path.split("/").pop();
  return base && base.length ? base : path;
}

/**
 * Compact chip text. Never returns an empty string: an unresolvable ref still
 * shows something honest (its kind, or a truncated id) rather than a blank chip.
 */
export function refLabel(ref: ChatRef, ctx: RefLabelContext = {}): string {
  switch (ref.kind) {
    case "unit": {
      const title = ref.id ? ctx.unitTitle?.(ref.id) : undefined;
      return title ?? (ref.id ? `unit ${shortId(ref.id)}` : "unit");
    }
    case "hunk": {
      const hunk = ref.id ? ctx.hunk?.(ref.id) : undefined;
      if (!hunk) return ref.id ? `hunk ${shortId(ref.id)}` : "hunk";
      const end = hunk.newStart + Math.max(hunk.newLines - 1, 0);
      return `${baseName(hunk.file)}:${hunk.newStart}-${end}`;
    }
    case "file":
      return ref.path ? baseName(ref.path) : "file";
    case "line-range": {
      const name = ref.path ? baseName(ref.path) : "lines";
      if (ref.start === undefined) return name;
      const range = ref.end !== undefined && ref.end !== ref.start ? `${ref.start}-${ref.end}` : `${ref.start}`;
      return `${name}:${range}${ref.side === "old" ? " (old)" : ""}`;
    }
    case "comment": {
      const c = ref.id ? ctx.comment?.(ref.id) : undefined;
      const where = c
        ? `${baseName(c.file)}:${c.line}`
        : ref.path
          ? `${baseName(ref.path)}${ref.start !== undefined ? `:${ref.start}` : ""}`
          : shortId(ref.id ?? "");
      return `comment @ ${where}`;
    }
    default:
      return "ref";
  }
}

/** Full path / identity, for the chip's tooltip. */
export function refTitle(ref: ChatRef, ctx: RefLabelContext = {}): string {
  switch (ref.kind) {
    case "unit":
      return `Review unit: ${refLabel(ref, ctx)}`;
    case "hunk": {
      const hunk = ref.id ? ctx.hunk?.(ref.id) : undefined;
      return hunk ? `Hunk in ${hunk.file}` : "Hunk";
    }
    case "file":
      return `File: ${ref.path ?? ""}`;
    case "line-range":
      return `${ref.path ?? ""} lines ${ref.start ?? "?"}–${ref.end ?? "?"} (${ref.side ?? "new"} side)`;
    case "comment": {
      const c = ref.id ? ctx.comment?.(ref.id) : undefined;
      return c ? `Comment on ${c.file}:${c.line}` : "Comment";
    }
    default:
      return "";
  }
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** Build the lookup context from the loaded PR + its comments. */
export function refContext(
  detail: PrDetail | undefined,
  comments: DraftComment[] = [],
): RefLabelContext {
  const units = new Map<string, ReviewUnit>();
  const hunks = new Map<string, Hunk>();
  const files = new Map<string, FileEntry>();
  if (detail) {
    for (const u of detail.state.units) units.set(u.id, u);
    for (const f of detail.files.files) {
      files.set(f.path, f);
      for (const h of f.hunks) hunks.set(h.id, h);
    }
  }
  const byId = new Map(comments.map((c) => [c.id, c]));
  return {
    unitTitle: (id) => units.get(id)?.title,
    hunk: (id) => {
      const h = hunks.get(id);
      return h
        ? {
            file: h.file,
            oldStart: h.oldStart,
            oldLines: h.oldLines,
            newStart: h.newStart,
            newLines: h.newLines,
          }
        : undefined;
    },
    comment: (id) => {
      const c = byId.get(id);
      return c ? { file: c.file, line: c.line } : undefined;
    },
  };
}
