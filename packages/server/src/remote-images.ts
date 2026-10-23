import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ghAsync, prDir, stateRoot, type PrKey } from "@reviewer/core";
import { HttpError } from "./http-error.js";

/**
 * Pictures other people put in the PR: the description's screenshots, the
 * images in a review or a comment. The web never loads them from GitHub
 * itself (nothing remote loads into the review page — see Markdown.tsx); it
 * asks `GET /api/prs/:key/image?url=<encoded>` and this module fetches the
 * file once, with the reader's own GitHub token, and keeps it under the PR's
 * state dir (`remote-images/<sha1(url)>.<ext>`, indexed by
 * `remote-images.json`). The second request is served from disk.
 *
 * Only GitHub's own image hosts are accepted (`allowedRemoteImageUrl`): the
 * proxy must not become a way to make the local server fetch arbitrary URLs
 * with a token attached. A private `user-attachments` asset answers 404
 * without a token and 302 to a short-lived signed S3 URL with
 * `Authorization: Bearer <token>`; `fetch` follows the redirect and, per the
 * fetch spec, drops the Authorization header on the cross-origin hop, which
 * is exactly what the signed URL requires.
 */

export const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024;

/** `Cache-Control` for a served picture: the bytes are kept locally, the browser may too, for a day. */
export const REMOTE_IMAGE_CACHE_CONTROL = "private, max-age=86400";

const RemoteImageSchema = z.object({
  url: z.string().url(),
  /** `sha1(url)`; the local file is `<sha><ext>` */
  sha: z.string().min(1),
  ext: z.string().min(1),
  mime: z.string().min(1),
  size: z.number().int().nonnegative(),
  fetchedAt: z.string(),
});
export type RemoteImage = z.infer<typeof RemoteImageSchema>;

const IndexSchema = z.object({ images: z.array(RemoteImageSchema) });
type RemoteImageIndex = z.infer<typeof IndexSchema>;

/* -------------------------------------------------------------- allowlist */

/**
 * The hosts GitHub serves pictures from. `host` is the PR's own GitHub host,
 * so a GHE / ghe.com tenant's assets are accepted for a PR that lives there.
 * Returns the parsed URL, or null for anything else.
 */
export function allowedRemoteImageUrl(raw: string, host = "github.com"): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const h = url.hostname.toLowerCase();
  const p = url.pathname;
  const ghHost = (host || "github.com").toLowerCase();
  if (h === "github.com" || h === ghHost) {
    // /user-attachments/assets/<id>, or /<owner>/<repo>/assets/<...>
    return /^\/user-attachments\/assets\/[^/]+$/.test(p) || /^\/[^/]+\/[^/]+\/assets\/.+/.test(p) ? url : null;
  }
  if (
    h === "private-user-images.githubusercontent.com" ||
    h === "user-images.githubusercontent.com" ||
    h === "camo.githubusercontent.com"
  ) {
    return p.length > 1 ? url : null;
  }
  return null;
}

/* ------------------------------------------------------------------ token */

/**
 * The GitHub token `gh` holds for a host, once per process. `gh auth token`
 * is what gh itself sends; a host gh is not logged into yields null and the
 * fetch goes out without credentials (public pictures still load).
 */
const tokens = new Map<string, Promise<string | null>>();

export function githubToken(host: string): Promise<string | null> {
  const h = (host || "github.com").toLowerCase();
  let pending = tokens.get(h);
  if (!pending) {
    pending = ghAsync(["auth", "token", ...(h !== "github.com" ? ["--hostname", h] : [])])
      .then(token => token.trim() || null, () => null);
    tokens.set(h, pending);
  }
  return pending;
}

export function resetGithubTokenCache(): void {
  tokens.clear();
}

/* ------------------------------------------------------------------ store */

export function remoteImagesDir(key: PrKey, root = stateRoot()): string {
  return path.join(prDir(key, root), "remote-images");
}

export function remoteImagesIndexPath(key: PrKey, root = stateRoot()): string {
  return path.join(prDir(key, root), "remote-images.json");
}

export function remoteImageFilePath(key: PrKey, img: Pick<RemoteImage, "sha" | "ext">, root = stateRoot()): string {
  return path.join(remoteImagesDir(key, root), `${img.sha}${img.ext}`);
}

function readIndex(key: PrKey, root: string): RemoteImageIndex {
  const file = remoteImagesIndexPath(key, root);
  if (!fs.existsSync(file)) return { images: [] };
  try {
    return IndexSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    // A corrupt index only costs a refetch.
    return { images: [] };
  }
}

function writeIndex(key: PrKey, index: RemoteImageIndex, root: string): void {
  const file = remoteImagesIndexPath(key, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(index, null, 2) + "\n", "utf8");
}

export function readRemoteImages(key: PrKey, root = stateRoot()): RemoteImage[] {
  return readIndex(key, root).images;
}

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

/** A file extension for the content type GitHub answered with. */
const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/avif": ".avif",
  "image/bmp": ".bmp",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
};

function extFor(mime: string): string {
  if (EXT_BY_MIME[mime]) return EXT_BY_MIME[mime];
  const sub = mime.split("/")[1]?.replace(/[^a-z0-9]/g, "");
  return sub ? `.${sub}` : ".bin";
}

/* ------------------------------------------------------------------ fetch */

export interface RemoteImageDeps {
  fetch: typeof fetch;
  token: (host: string) => string | null | Promise<string | null>;
}

const defaultDeps: RemoteImageDeps = {
  fetch: (input, init) => fetch(input, init),
  token: githubToken,
};

/** Requests in flight by `<key>|<url>`: two renders of the same picture fetch it once. */
const inflight = new Map<string, Promise<RemoteImage>>();

/**
 * The local copy of a remote picture, fetched on the first request. Throws an
 * HttpError the route can send as is: 400 for a URL off the allowlist, 413
 * over the size cap, 415 for a non-image answer, 502 for anything GitHub or
 * the network did wrong.
 */
export async function fetchRemoteImage(
  key: PrKey,
  raw: string,
  root = stateRoot(),
  deps: RemoteImageDeps = defaultDeps,
): Promise<RemoteImage> {
  const url = allowedRemoteImageUrl(raw, key.host);
  if (!url) {
    throw new HttpError(400, "remote_image_not_allowed", "Only pictures hosted by GitHub are proxied");
  }
  const href = url.href;
  const cached = readIndex(key, root).images.find((i) => i.url === href);
  if (cached && fs.existsSync(remoteImageFilePath(key, cached, root))) return cached;

  const id = `${key.host}/${key.owner}/${key.repo}/${key.number}|${href}`;
  const pending = inflight.get(id);
  if (pending) return pending;
  const task = download(key, url, root, deps).finally(() => inflight.delete(id));
  inflight.set(id, task);
  return task;
}

async function download(key: PrKey, url: URL, root: string, deps: RemoteImageDeps): Promise<RemoteImage> {
  const token = await deps.token(key.host);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let res: Response;
  try {
    res = await deps.fetch(url.href, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "image/*,video/*;q=0.9,*/*;q=0.1",
        "user-agent": "purview",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
  } catch (err) {
    clearTimeout(timer);
    const reason = err instanceof Error ? err.message : String(err);
    throw new HttpError(502, "remote_image_failed", `Could not fetch ${url.hostname}: ${reason}`);
  }
  try {
    if (!res.ok) {
      throw new HttpError(502, "remote_image_failed", `GitHub answered HTTP ${res.status} for the picture`);
    }
    const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!/^(image|video)\//.test(mime)) {
      throw new HttpError(415, "remote_image_not_media", `GitHub answered ${mime || "no content type"}, not a picture`);
    }
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_REMOTE_IMAGE_BYTES) {
      throw new HttpError(413, "remote_image_too_large", `The picture is larger than ${MAX_REMOTE_IMAGE_BYTES / 1024 / 1024} MB`);
    }
    const bytes = await readCapped(res, MAX_REMOTE_IMAGE_BYTES, controller);
    const image: RemoteImage = {
      url: url.href,
      sha: sha1(url.href),
      ext: extFor(mime),
      mime,
      size: bytes.length,
      fetchedAt: new Date().toISOString(),
    };
    fs.mkdirSync(remoteImagesDir(key, root), { recursive: true });
    fs.writeFileSync(remoteImageFilePath(key, image, root), bytes);
    const index = readIndex(key, root);
    index.images = index.images.filter((i) => i.url !== image.url);
    index.images.push(image);
    writeIndex(key, index, root);
    return image;
  } finally {
    clearTimeout(timer);
  }
}

/** The whole body, or a 413 as soon as it passes `max` (the download is aborted, not finished). */
async function readCapped(res: Response, max: number, controller: AbortController): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      controller.abort();
      throw new HttpError(413, "remote_image_too_large", `The picture is larger than ${max / 1024 / 1024} MB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
