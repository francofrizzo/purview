import type { DraftComment } from "../api/types";

/**
 * Pictures in comments. A pasted or dropped image is uploaded to the local
 * server (never to GitHub until the draft is pushed — see the server's
 * attachments.ts) and referred to from the body as
 * `![name](purview-attachment:<id>)`. At push time the server uploads the file
 * to GitHub and rewrites the reference to the asset URL GitHub answers with;
 * the local copy stays, so the picture keeps previewing from here.
 */

export const ATTACHMENT_SCHEME = "purview-attachment:";

const REF_RE = /!\[([^\]\n]*)\]\(purview-attachment:([0-9a-f-]{36})\)/g;

/** The one line that gets inserted into a body for an attachment. */
export function attachmentMarkdown(name: string, id: string): string {
  return `![${escapeAlt(name)}](${ATTACHMENT_SCHEME}${id})`;
}

/**
 * Alt text must not close the image early: `](url)` inside a file name would
 * point the image somewhere the author did not choose (gh escapes the same).
 */
export function escapeAlt(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]").replace(/[\r\n]+/g, " ");
}

/** The attachment ids a body refers to, in order, without repeats. */
export function attachmentRefs(body: string): string[] {
  const ids: string[] = [];
  for (const m of body.matchAll(REF_RE)) if (!ids.includes(m[2])) ids.push(m[2]);
  return ids;
}

/** The id behind a `purview-attachment:` href, or null for any other URL. */
export function attachmentIdOf(href: string): string | null {
  return href.startsWith(ATTACHMENT_SCHEME) ? href.slice(ATTACHMENT_SCHEME.length) || null : null;
}

/** A GitHub user-attachments asset URL — what a pushed reference turns into. */
export function isGithubAssetUrl(href: string): boolean {
  return /^https:\/\/github\.com\/user-attachments\/assets\//.test(href);
}

/**
 * Take every reference to one attachment out of a body, along with the
 * whitespace that was only there to separate it.
 */
export function removeAttachmentRef(body: string, id: string): string {
  return body
    .replace(new RegExp(`[ \\t]*!\\[[^\\]\\n]*\\]\\(purview-attachment:${id}\\)[ \\t]*`, "g"), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Insert text at a textarea selection, on its own line when the text is a
 * picture (markdown draws an image inline otherwise, mid-sentence). Returns
 * the new body and where the caret goes.
 */
export function insertAtSelection(
  body: string,
  selection: { start: number; end: number },
  text: string,
): { body: string; caret: number } {
  const before = body.slice(0, selection.start);
  const after = body.slice(selection.end);
  const lead = before === "" || before.endsWith("\n") ? "" : before.endsWith("\n\n") ? "" : "\n";
  const trail = after === "" || after.startsWith("\n") ? "" : "\n";
  const inserted = `${lead}${text}${trail}`;
  return { body: `${before}${inserted}${after}`, caret: before.length + inserted.length };
}

/** How many pictures a draft still carries locally (i.e. not yet uploaded to GitHub). */
export function pendingAttachmentCount(comment: Pick<DraftComment, "body" | "status">): number {
  if ((comment.status ?? "draft") !== "draft") return 0;
  return attachmentRefs(comment.body).length;
}

/* ------------------------------------------------------------ file checks */

/** What GitHub's user-attachments store accepts, as gh lists it. */
export const ATTACHMENT_TYPES: readonly { ext: string; mime: string }[] = [
  { ext: ".png", mime: "image/png" },
  { ext: ".jpg", mime: "image/jpeg" },
  { ext: ".jpeg", mime: "image/jpeg" },
  { ext: ".gif", mime: "image/gif" },
  { ext: ".webp", mime: "image/webp" },
  { ext: ".svg", mime: "image/svg+xml" },
  { ext: ".mp4", mime: "video/mp4" },
  { ext: ".mov", mime: "video/quicktime" },
  { ext: ".webm", mime: "video/webm" },
];

/** The `accept` attribute for the file picker. */
export const ATTACHMENT_ACCEPT = ATTACHMENT_TYPES.map((t) => t.ext).join(",");

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

/** Why a file cannot be attached, before a byte is uploaded; null when it can. */
export function attachmentFileError(file: { name: string; type: string; size: number }): string | null {
  const ext = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")).toLowerCase() : "";
  const type =
    ATTACHMENT_TYPES.find((t) => t.ext === ext) ?? ATTACHMENT_TYPES.find((t) => t.mime === file.type.toLowerCase());
  if (!type) {
    return `${file.name || "This file"} is not an image GitHub accepts (${ATTACHMENT_TYPES.map((t) => t.ext.slice(1)).join(", ")})`;
  }
  if (file.size === 0) return `${file.name || "This file"} is empty`;
  const video = type.mime.startsWith("video/");
  const max = video ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (file.size > max) return `${file.name}: ${video ? "videos" : "images"} must be at most ${max / 1024 / 1024} MB`;
  return null;
}

/** The files a paste or drop carries that are images or videos, in order. */
export function mediaFiles(list: FileList | DataTransferItemList | null | undefined): File[] {
  if (!list) return [];
  const out: File[] = [];
  for (let i = 0; i < list.length; i++) {
    const entry = list[i] as File | DataTransferItem;
    const file = entry instanceof File ? entry : entry.kind === "file" ? entry.getAsFile() : null;
    if (file && /^(image|video)\//.test(file.type)) out.push(file);
  }
  return out;
}
