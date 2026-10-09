import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { gh, prDir, stateRoot, type PrKey } from "@reviewer/core";
import { HttpError } from "./http-error.js";

/**
 * Images (and short videos) attached to draft comments.
 *
 * A file pasted or dropped into the composer lands here, under the PR's state
 * dir (`attachments/<id>.<ext>`, indexed by `attachments.json`), and the draft
 * refers to it as `![name](purview-attachment:<id>)`. Nothing reaches GitHub
 * until the draft is pushed: the push resolves every reference by uploading
 * the file to GitHub's user-attachments store (once — the resulting URL is
 * remembered in the index, so a retry never re-uploads) and rewrites the body
 * to the `https://github.com/user-attachments/assets/<id>` URL GitHub gave
 * back. The local copy stays, so the web can keep previewing the picture
 * without loading it from GitHub.
 *
 * The upload mirrors what `gh pr comment --attach` does (cli/cli v2.102.0,
 * internal/attachments): same endpoint, parameters, headers, accepted types
 * and size limits. An upload cannot be undone, and nothing here ever deletes
 * anything on GitHub.
 */

export const ATTACHMENT_SCHEME = "purview-attachment:";

/** `![alt](purview-attachment:<id>)` — the one way a body refers to a local attachment. */
const REF_RE = /!\[([^\]\n]*)\]\(purview-attachment:([0-9a-f-]{36})\)/g;

/** The largest image gh uploads (internal/attachments/userasset.go). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** The largest video gh uploads; the real limit depends on the plan, the endpoint refuses the rest. */
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

/**
 * Every accepted extension and the content type the endpoint expects for it,
 * in gh's order. gh checks the extension only ("the endpoint accepts
 * mislabeled bytes anyway"); so does this.
 */
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

export const AttachmentSchema = z.object({
  id: z.string().uuid(),
  /** the file name as the reader attached it (alt text, and `name` on upload) */
  name: z.string().min(1),
  mime: z.string().min(1),
  /** lower-case, with the dot; the local file is `<id><ext>` */
  ext: z.string().min(1),
  size: z.number().int().nonnegative(),
  createdAt: z.string(),
  /** set once uploaded to GitHub; the body is rewritten to it at push time */
  githubUrl: z.string().url().optional(),
  uploadedAt: z.string().optional(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

const IndexSchema = z.object({
  /**
   * The repo's numeric REST id — what the upload endpoint wants as
   * `repository_id`. Looked up once per PR and kept here.
   */
  repositoryId: z.number().int().positive().optional(),
  attachments: z.array(AttachmentSchema),
});
type AttachmentIndex = z.infer<typeof IndexSchema>;

export function attachmentsDir(key: PrKey, root = stateRoot()): string {
  return path.join(prDir(key, root), "attachments");
}

export function attachmentsIndexPath(key: PrKey, root = stateRoot()): string {
  return path.join(prDir(key, root), "attachments.json");
}

export function attachmentFilePath(key: PrKey, a: Pick<Attachment, "id" | "ext">, root = stateRoot()): string {
  return path.join(attachmentsDir(key, root), `${a.id}${a.ext}`);
}

function readIndex(key: PrKey, root: string): AttachmentIndex {
  const file = attachmentsIndexPath(key, root);
  if (!fs.existsSync(file)) return { attachments: [] };
  try {
    return IndexSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    // A corrupt index must never take comments down; the files are still on
    // disk, only their bookkeeping is gone.
    return { attachments: [] };
  }
}

function writeIndex(key: PrKey, index: AttachmentIndex, root: string): void {
  const file = attachmentsIndexPath(key, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(index, null, 2) + "\n", "utf8");
}

export function readAttachments(key: PrKey, root = stateRoot()): Attachment[] {
  return readIndex(key, root).attachments;
}

export function findAttachment(key: PrKey, id: string, root = stateRoot()): Attachment | undefined {
  return readAttachments(key, root).find((a) => a.id === id);
}

/* ------------------------------------------------------------- validation */

/**
 * The content type for a file name, by extension — or, when the name has no
 * usable extension (a pasted clipboard image is often just "image"), by the
 * mime type the browser reported. `undefined` when neither is accepted.
 */
export function acceptedType(name: string, mime?: string): { ext: string; mime: string } | undefined {
  const ext = path.extname(name).toLowerCase();
  const byExt = ATTACHMENT_TYPES.find((t) => t.ext === ext);
  if (byExt) return byExt;
  if (mime) {
    const m = mime.split(";")[0].trim().toLowerCase();
    const byMime = ATTACHMENT_TYPES.find((t) => t.mime === m);
    if (byMime) return byMime;
  }
  return undefined;
}

export function supportedExtensions(): string {
  return ATTACHMENT_TYPES.map((t) => t.ext.slice(1)).join(", ");
}

/** Validate and store one file. Throws an HttpError the route can send as is. */
export function storeAttachment(
  key: PrKey,
  input: { name: string; mime?: string; bytes: Buffer },
  root = stateRoot(),
): Attachment {
  const name = path.basename(input.name.trim()) || "image";
  const type = acceptedType(name, input.mime);
  if (!type) {
    throw new HttpError(
      415,
      "unsupported_attachment",
      `${name} is not a supported file type (supported: ${supportedExtensions()})`,
    );
  }
  if (input.bytes.length === 0) {
    throw new HttpError(400, "empty_attachment", `${name} is empty`);
  }
  const video = type.mime.startsWith("video/");
  const max = video ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (input.bytes.length > max) {
    throw new HttpError(
      413,
      "attachment_too_large",
      `${name}: ${video ? "videos" : "images"} must be at most ${max / 1024 / 1024} MB`,
    );
  }
  const attachment: Attachment = {
    id: randomUUID(),
    // Keep the name's own extension; add the one we inferred when it had none.
    name: path.extname(name).toLowerCase() === type.ext ? name : `${name}${type.ext}`,
    mime: type.mime,
    ext: type.ext,
    size: input.bytes.length,
    createdAt: new Date().toISOString(),
  };
  const dir = attachmentsDir(key, root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(attachmentFilePath(key, attachment, root), input.bytes);
  const index = readIndex(key, root);
  index.attachments.push(attachment);
  writeIndex(key, index, root);
  return attachment;
}

/* ------------------------------------------------------------- references */

/** The attachment ids a body refers to, in order, without repeats. */
export function attachmentRefs(body: string): string[] {
  const ids: string[] = [];
  for (const m of body.matchAll(REF_RE)) if (!ids.includes(m[2])) ids.push(m[2]);
  return ids;
}

/**
 * A body may only refer to attachments that exist on this PR. Checked on
 * every write that carries a body — the web's, and the chat's through the
 * CLI, which has no way to attach a file but could still name an id.
 */
export function assertAttachmentRefsExist(key: PrKey, body: string, root = stateRoot()): void {
  const refs = attachmentRefs(body);
  if (refs.length === 0) return;
  const known = new Set(readAttachments(key, root).map((a) => a.id));
  const missing = refs.filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw new HttpError(
      422,
      "unknown_attachment",
      `The comment refers to an attachment that does not exist: ${missing.join(", ")}`,
    );
  }
}

/** True when any of the given bodies refers to the attachment, before or after its upload. */
function referencedBy(a: Attachment, bodies: string[]): boolean {
  const local = `${ATTACHMENT_SCHEME}${a.id})`;
  return bodies.some((b) => b.includes(local) || (a.githubUrl !== undefined && b.includes(a.githubUrl)));
}

/**
 * Drop every attachment nothing refers to any more — not a comment, not one
 * of its earlier bodies (undo could bring the reference back), not a deleted
 * draft still in the trash. Local files only; GitHub is never touched.
 */
export function pruneAttachments(key: PrKey, bodies: string[], root = stateRoot()): string[] {
  const index = readIndex(key, root);
  const gone = index.attachments.filter((a) => !referencedBy(a, bodies));
  if (gone.length === 0) return [];
  for (const a of gone) fs.rmSync(attachmentFilePath(key, a, root), { force: true });
  index.attachments = index.attachments.filter((a) => referencedBy(a, bodies));
  writeIndex(key, index, root);
  return gone.map((a) => a.id);
}

/**
 * Remove one attachment the composer no longer wants (its thumbnail was
 * removed, or the composer was discarded). Refused while a comment still
 * refers to it.
 */
export function deleteAttachment(
  key: PrKey,
  id: string,
  bodies: string[],
  root = stateRoot(),
): "removed" | "referenced" | "missing" {
  const index = readIndex(key, root);
  const target = index.attachments.find((a) => a.id === id);
  if (!target) return "missing";
  if (referencedBy(target, bodies)) return "referenced";
  fs.rmSync(attachmentFilePath(key, target, root), { force: true });
  index.attachments = index.attachments.filter((a) => a.id !== id);
  writeIndex(key, index, root);
  return "removed";
}

/* ------------------------------------------------------------ GitHub side */

function hostArgs(host: string): string[] {
  return host && host !== "github.com" ? ["--hostname", host] : [];
}

/**
 * gh refuses GitHub Enterprise Server outright: the user-attachments
 * endpoint only exists on github.com and on ghe.com tenants (data
 * residency), where it lives at `uploads.<host>`.
 */
export function uploadEndpoint(host: string): string {
  const h = (host || "github.com").toLowerCase();
  if (h !== "github.com" && !h.endsWith(".ghe.com")) {
    throw new Error("attaching files is not supported on GitHub Enterprise Server");
  }
  return `https://uploads.${h}/user-attachments/assets`;
}

/** `gh api repos/{o}/{r}` -> `id`, remembered in the index. */
function repositoryId(key: PrKey, index: AttachmentIndex): number {
  if (index.repositoryId) return index.repositoryId;
  const raw = JSON.parse(gh(["api", ...hostArgs(key.host), `repos/${key.owner}/${key.repo}`])) as {
    id?: unknown;
  };
  if (typeof raw.id !== "number" || raw.id <= 0) {
    throw new Error("could not determine which repository to attach files to");
  }
  index.repositoryId = raw.id;
  return raw.id;
}

/**
 * Explain an upload failure the way gh does (internal/attachments/client.go,
 * `uploadError`): the endpoint answers 404, not 403, to a token that cannot
 * write, so the status alone would point at the wrong problem.
 */
function explainUploadFailure(name: string, raw: string): string {
  if (/HTTP 404/i.test(raw)) {
    return `could not upload ${name}: attaching files requires write access to the repository`;
  }
  if (/HTTP 422/i.test(raw)) {
    const msg = raw.replace(/^gh .* failed:\s*/s, "").replace(/\n/g, "; ").trim();
    return `could not upload ${name}${msg ? `: ${msg}` : ""}`;
  }
  if (/HTTP 429/i.test(raw)) {
    return `could not upload ${name}: rate limited; wait and try again`;
  }
  return `failed to upload ${name}: ${raw}`;
}

/**
 * THE ONE CALL THAT WRITES TO GITHUB. Uploads a stored file to GitHub's
 * user-attachments store and records the asset URL in the index. Exactly what
 * gh does (`Uploader.postAsset`, cli/cli v2.102.0 internal/attachments/client.go):
 *
 *   POST https://uploads.github.com/user-attachments/assets
 *        ?name=<basename>&content_type=<mime>&repository_id=<numeric repo id>
 *   Content-Type: application/octet-stream
 *   Accept: application/vnd.github+json
 *   <raw file bytes>
 *   -> { "url": "https://github.com/user-attachments/assets/<id>" }
 *
 * Sent through `gh api` rather than curl: gh takes an absolute URL as is and,
 * because `uploads.github.com` normalizes to `github.com`, adds the host's
 * token itself, so no token ever passes through this process. `--input` reads
 * the file from disk (binary never goes through stdin as a string).
 *
 * Not retried on failure and never re-run for an attachment that already has
 * a `githubUrl`: an upload cannot be undone.
 */
export function uploadAttachmentToGithub(key: PrKey, id: string, root = stateRoot()): Attachment {
  const index = readIndex(key, root);
  const target = index.attachments.find((a) => a.id === id);
  if (!target) throw new Error(`No attachment "${id}"`);
  if (target.githubUrl) return target;

  const endpoint = uploadEndpoint(key.host);
  const repoId = repositoryId(key, index);
  // The repo id is worth keeping even if the upload below fails.
  writeIndex(key, index, root);

  const file = attachmentFilePath(key, target, root);
  if (!fs.existsSync(file)) throw new Error(`The file for attachment "${target.name}" is gone from disk`);
  const query = new URLSearchParams({
    name: target.name,
    content_type: target.mime,
    repository_id: String(repoId),
  });
  let out: string;
  try {
    out = gh([
      "api",
      ...hostArgs(key.host),
      "--method",
      "POST",
      "-H",
      "Content-Type: application/octet-stream",
      "-H",
      "Accept: application/vnd.github+json",
      "--input",
      file,
      `${endpoint}?${query.toString()}`,
    ]);
  } catch (err) {
    throw new Error(explainUploadFailure(target.name, err instanceof Error ? err.message : String(err)));
  }
  let url: unknown;
  try {
    url = (JSON.parse(out) as { url?: unknown }).url;
  } catch {
    throw new Error(`failed to upload ${target.name}: the server returned no asset URL`);
  }
  if (typeof url !== "string" || url === "") {
    throw new Error(`failed to upload ${target.name}: the server returned no asset URL`);
  }
  target.githubUrl = url;
  target.uploadedAt = new Date().toISOString();
  writeIndex(key, index, root);
  return target;
}

/**
 * The body as GitHub should receive it: every local reference uploaded (if
 * it was not already) and rewritten to its asset URL — an image stays a
 * markdown image; a video becomes a bare URL, which GitHub promotes to a
 * player (markdown has no syntax for one; gh does the same). Throws on the
 * first upload that fails, with nothing rewritten: the caller keeps the
 * local body and reports the error.
 */
export function resolveBodyForGithub(key: PrKey, body: string, root = stateRoot()): string {
  const refs = attachmentRefs(body);
  if (refs.length === 0) return body;
  const uploaded = new Map<string, Attachment>();
  for (const id of refs) uploaded.set(id, uploadAttachmentToGithub(key, id, root));
  return body.replace(REF_RE, (whole, alt: string, id: string) => {
    const a = uploaded.get(id);
    if (!a?.githubUrl) return whole;
    return a.mime.startsWith("video/") ? a.githubUrl : `![${alt}](${a.githubUrl})`;
  });
}
