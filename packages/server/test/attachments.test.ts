import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setGhRunner } from "@reviewer/core";
import { createApp } from "../src/app.js";
import {
  MAX_IMAGE_BYTES,
  attachmentFilePath,
  attachmentRefs,
  readAttachments,
  uploadEndpoint,
} from "../src/attachments.js";
import { readComments, readDeletedComments } from "../src/comments.js";
import { buildFixture, key } from "./fixtures.js";
import { fakeGh, type FakeGh } from "./fake-gh.js";

const encodedKey = encodeURIComponent(`${key.host}/${key.owner}/${key.repo}/${key.number}`);

let root: string;
let app: ReturnType<typeof createApp>;
let gh: FakeGh;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-attachments-test-"));
  buildFixture(root);
  app = createApp({ stateDir: root, webDist: path.join(root, "__no-web-dist__") });
  gh = fakeGh();
  gh.install();
});

afterEach(() => {
  setGhRunner(null);
  fs.rmSync(root, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ helpers */

/** A tiny but real-looking PNG: signature plus a few bytes. The server checks the name, not the pixels. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("purview")]);

const json = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

async function upload(name: string, bytes: Buffer = PNG, mime = "image/png") {
  const res = await app.request(`/api/prs/${encodedKey}/attachments?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": mime },
    body: new Uint8Array(bytes),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function addDraft(body: string, line = 2) {
  const res = await app.request(`/api/prs/${encodedKey}/comments`, {
    ...json({ file: "src/foo.ts", line, side: "RIGHT", body }),
  });
  return { status: res.status, comment: ((await res.json()) as any).comment as { id: string } };
}

const ref = (id: string, alt = "shot") => `![${alt}](purview-attachment:${id})`;
const sync = async () => ((await (await app.request(`/api/prs/${encodedKey}/sync`, { method: "POST" })).json()) as any).comments;

/* -------------------------------------------------------------- the store */

describe("local attachment store", () => {
  it("stores a pasted image under the PR and serves it back", async () => {
    const { status, body } = await upload("shot.png");
    expect(status).toBe(201);
    const a = body.attachment;
    expect(a).toMatchObject({ name: "shot.png", mime: "image/png", ext: ".png", size: PNG.length });
    expect(a.githubUrl).toBeUndefined();
    expect(fs.readFileSync(attachmentFilePath(key, a, root))).toEqual(PNG);

    const got = await app.request(`/api/prs/${encodedKey}/attachments/${a.id}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await got.arrayBuffer())).toEqual(PNG);

    const list = (await (await app.request(`/api/prs/${encodedKey}/attachments`)).json()) as any;
    expect(list.attachments.map((x: any) => x.id)).toEqual([a.id]);
  });

  it("names a nameless clipboard image by its mime type", async () => {
    const { body } = await upload("image", PNG, "image/png");
    expect(body.attachment.name).toBe("image.png");
    expect(body.attachment.ext).toBe(".png");
  });

  it("rejects what gh would reject: unknown types, empty files, oversize images", async () => {
    expect((await upload("notes.txt", Buffer.from("hi"), "text/plain")).status).toBe(415);
    expect((await upload("shot.png", Buffer.alloc(0))).status).toBe(400);
    const big = await upload("huge.png", Buffer.alloc(MAX_IMAGE_BYTES + 1));
    expect(big.status).toBe(413);
    expect(big.body.detail).toMatch(/at most 10 MB/);
    expect(readAttachments(key, root)).toEqual([]);
  });

  it("sandboxes an SVG so it cannot script this origin when opened directly", async () => {
    const { body } = await upload("diagram.svg", Buffer.from("<svg/>"), "image/svg+xml");
    const got = await app.request(`/api/prs/${encodedKey}/attachments/${body.attachment.id}`);
    expect(got.headers.get("content-security-policy")).toBe("sandbox");
  });

  it("404s an unknown attachment", async () => {
    const got = await app.request(`/api/prs/${encodedKey}/attachments/00000000-0000-0000-0000-000000000000`);
    expect(got.status).toBe(404);
  });
});

/* ---------------------------------------------------------------- references */

describe("attachment references in comment bodies", () => {
  it("finds every `purview-attachment:` reference once, in order", () => {
    const a = "11111111-1111-4111-8111-111111111111";
    const b = "22222222-2222-4222-8222-222222222222";
    expect(attachmentRefs(`see ${ref(a)} and ${ref(b, "two")} then ${ref(a)} again`)).toEqual([a, b]);
    expect(attachmentRefs("no pictures here")).toEqual([]);
    expect(attachmentRefs("[not an image](purview-attachment:" + a + ")")).toEqual([]);
  });

  it("refuses a comment that names an attachment this PR does not have", async () => {
    const { status } = await addDraft(`look ${ref("00000000-0000-4000-8000-000000000000")}`);
    expect(status).toBe(422);
    expect(readComments(key, root)).toEqual([]);
  });

  it("accepts a comment that names a stored attachment, and keeps the body local", async () => {
    const { body } = await upload("shot.png");
    const { status } = await addDraft(`look ${ref(body.attachment.id)}`);
    expect(status).toBe(201);
    expect(readComments(key, root)[0].body).toContain(`purview-attachment:${body.attachment.id}`);
    expect(gh.uploads).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------- push */

describe("uploading at push time", () => {
  it("uploads the way gh does and rewrites the body to the asset URL", async () => {
    const { body } = await upload("shot.png");
    const a = body.attachment;
    const { comment } = await addDraft(`before ${ref(a.id)} after`);

    const result = await sync();
    expect(result.ok).toBe(true);
    expect(result.pushed).toBe(1);

    expect(gh.uploads).toHaveLength(1);
    const up = gh.uploads[0];
    expect(up).toMatchObject({ name: "shot.png", contentType: "image/png", repositoryId: "424242" });
    expect(up.input).toBe(attachmentFilePath(key, a, root));
    expect(up.headers).toEqual(["Content-Type: application/octet-stream", "Accept: application/vnd.github+json"]);
    expect(up.url).toBe("https://github.com/user-attachments/assets/asset-1");
    // The whole call, as the coordinator will see it against real GitHub.
    const call = gh.calls.find((c) => c.some((x) => x.includes("user-attachments")))!;
    expect(call.slice(0, 3)).toEqual(["api", "--method", "POST"]);
    expect(call[call.length - 1]).toBe(
      "https://uploads.github.com/user-attachments/assets?name=shot.png&content_type=image%2Fpng&repository_id=424242",
    );

    // GitHub got the rewritten body; so did the local copy, once it was accepted.
    expect(gh.reviews[0].comments[0].body).toBe(`before ![shot](${up.url}) after`);
    const stored = readComments(key, root).find((c) => c.id === comment.id)!;
    expect(stored.status).toBe("pushed");
    expect(stored.body).toBe(`before ![shot](${up.url}) after`);
    expect(stored.history).toBeUndefined();

    // Remembered, so nothing re-uploads it.
    expect(readAttachments(key, root)[0].githubUrl).toBe(up.url);
    expect(fs.existsSync(attachmentFilePath(key, a, root))).toBe(true);
  });

  it("uploads an attachment once even when two drafts share it", async () => {
    const { body } = await upload("shot.png");
    await addDraft(`one ${ref(body.attachment.id)}`, 2);
    await addDraft(`two ${ref(body.attachment.id)}`, 11);
    const result = await sync();
    expect(result.pushed).toBe(2);
    expect(gh.uploads).toHaveLength(1);
    expect(gh.reviews[0].comments.map((c) => c.body)).toEqual([
      "one ![shot](https://github.com/user-attachments/assets/asset-1)",
      "two ![shot](https://github.com/user-attachments/assets/asset-1)",
    ]);
  });

  it("looks the repository id up once and keeps it", async () => {
    const first = await upload("a.png");
    await addDraft(`a ${ref(first.body.attachment.id)}`, 2);
    await sync();
    const second = await upload("b.png");
    await addDraft(`b ${ref(second.body.attachment.id)}`, 11);
    await sync();
    const repoLookups = gh.calls.filter((c) => c[c.length - 1] === "repos/acme/widgets");
    expect(repoLookups).toHaveLength(1);
    expect(gh.uploads).toHaveLength(2);
  });

  it("sends a video as a bare URL, which GitHub turns into a player", async () => {
    const { body } = await upload("demo.mp4", Buffer.from("not really a video"), "video/mp4");
    await addDraft(`watch:\n\n${ref(body.attachment.id, "demo.mp4")}\n\nthen`);
    await sync();
    expect(gh.uploads[0].contentType).toBe("video/mp4");
    expect(gh.reviews[0].comments[0].body).toBe("watch:\n\nhttps://github.com/user-attachments/assets/asset-1\n\nthen");
  });

  it("keeps the draft intact and reports the failure when the upload is refused (no pending review)", async () => {
    const { body } = await upload("shot.png");
    const { comment: withPicture } = await addDraft(`pic ${ref(body.attachment.id)}`, 2);
    const { comment: plain } = await addDraft("plain", 11);
    gh.fail("user-attachments", "HTTP 404 Not Found", true);

    const result = await sync();
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("attachment_upload_failed");
    expect(result.error).toMatch(/src\/foo\.ts:2/);
    expect(result.error).toMatch(/requires write access/);
    // The others went out; the one with the picture stayed home, as typed.
    expect(result.pushed).toBe(1);
    const stored = readComments(key, root);
    expect(stored.find((c) => c.id === plain.id)!.status).toBe("pushed");
    const kept = stored.find((c) => c.id === withPicture.id)!;
    expect(kept.status).toBe("draft");
    expect(kept.body).toBe(`pic ${ref(body.attachment.id)}`);
    expect(readAttachments(key, root)[0].githubUrl).toBeUndefined();
    expect(gh.reviews[0].comments.map((c) => c.body)).toEqual(["plain"]);

    // Once the upload works, the next push takes it.
    const retry = await sync();
    expect(retry.ok).toBe(true);
    expect(retry.pushed).toBe(1);
    expect(gh.uploads).toHaveLength(1);
  });

  it("stops at the failing upload when appending to a pending review", async () => {
    await addDraft("opens the review", 2);
    await sync();
    const { body } = await upload("shot.png");
    const { comment } = await addDraft(`pic ${ref(body.attachment.id)}`, 11);
    gh.fail("user-attachments", "HTTP 429 Too Many Requests");

    const result = await sync();
    expect(result.ok).toBe(false);
    expect(result.mode).toBe("appended");
    expect(result.errorCode).toBe("attachment_upload_failed");
    expect(result.error).toMatch(/rate limited/);
    expect(readComments(key, root).find((c) => c.id === comment.id)!.status).toBe("draft");
  });

  it("uploads a picture added by editing a comment that is already pushed", async () => {
    const { comment } = await addDraft("first text", 2);
    await sync();
    const { body } = await upload("later.png");
    const res = await app.request(`/api/prs/${encodedKey}/comments/${comment.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: `now with ${ref(body.attachment.id, "later")}` }),
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as any;
    expect(out.remote).toEqual({ ok: true });
    expect(gh.uploads).toHaveLength(1);
    const url = gh.uploads[0].url;
    expect(out.comment.body).toBe(`now with ![later](${url})`);
    expect(gh.reviews[0].comments[0].body).toBe(`now with ![later](${url})`);
    expect(readComments(key, root)[0].body).toBe(`now with ![later](${url})`);
  });

  it("reports a failed upload on an edit as 'saved locally, GitHub not updated'", async () => {
    const { comment } = await addDraft("first text", 2);
    await sync();
    const { body } = await upload("later.png");
    gh.fail("user-attachments", "HTTP 404 Not Found");
    const res = await app.request(`/api/prs/${encodedKey}/comments/${comment.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: `now with ${ref(body.attachment.id)}` }),
    });
    const out = (await res.json()) as any;
    expect(out.remote.ok).toBe(false);
    expect(out.remote.reason).toMatch(/write access/);
    expect(readComments(key, root)[0].body).toBe(`now with ${ref(body.attachment.id)}`);
    expect(gh.reviews[0].comments[0].body).toBe("first text");
  });
});

/* ----------------------------------------------------------------- cleanup */

describe("attachment cleanup", () => {
  it("keeps a trashed draft's picture (it can come back) and drops a deleted pushed comment's", async () => {
    const a = (await upload("a.png")).body.attachment;
    const b = (await upload("b.png")).body.attachment;
    const { comment: draft } = await addDraft(`a ${ref(a.id)}`, 2);
    const { comment: pushed } = await addDraft(`b ${ref(b.id)}`, 11);
    await sync(); // both pushed
    // Make the first one a draft again by hand, so the trash path is exercised.
    const stored = readComments(key, root);
    fs.writeFileSync(
      path.join(root, key.host, key.owner, key.repo, String(key.number), "comments.json"),
      JSON.stringify(stored.map((c) => (c.id === draft.id ? { ...c, status: "draft", body: `a ${ref(a.id)}` } : c))),
    );

    expect((await app.request(`/api/prs/${encodedKey}/comments/${draft.id}`, { method: "DELETE" })).status).toBe(200);
    expect(readDeletedComments(key, root).map((c) => c.id)).toEqual([draft.id]);
    expect(fs.existsSync(attachmentFilePath(key, a, root))).toBe(true);

    expect((await app.request(`/api/prs/${encodedKey}/comments/${pushed.id}`, { method: "DELETE" })).status).toBe(200);
    expect(fs.existsSync(attachmentFilePath(key, b, root))).toBe(false);
    expect(readAttachments(key, root).map((x) => x.id)).toEqual([a.id]);
    // Nothing on GitHub was touched beyond the comment itself.
    expect(gh.calls.some((c) => c.includes("DELETE") && c.some((x) => x.includes("user-attachments")))).toBe(false);
  });

  it("deletes an unreferenced attachment on request, and refuses one in use", async () => {
    const a = (await upload("a.png")).body.attachment;
    const b = (await upload("b.png")).body.attachment;
    await addDraft(`uses ${ref(a.id)}`);

    const inUse = await app.request(`/api/prs/${encodedKey}/attachments/${a.id}`, { method: "DELETE" });
    expect(inUse.status).toBe(409);
    expect(fs.existsSync(attachmentFilePath(key, a, root))).toBe(true);

    const free = await app.request(`/api/prs/${encodedKey}/attachments/${b.id}`, { method: "DELETE" });
    expect(free.status).toBe(200);
    expect(fs.existsSync(attachmentFilePath(key, b, root))).toBe(false);
    expect(readAttachments(key, root).map((x) => x.id)).toEqual([a.id]);
  });
});

/* ------------------------------------------------------------------- hosts */

describe("uploadEndpoint", () => {
  it("is uploads.github.com for github.com and uploads.<tenant> for a ghe.com tenant", () => {
    expect(uploadEndpoint("github.com")).toBe("https://uploads.github.com/user-attachments/assets");
    expect(uploadEndpoint("acme.ghe.com")).toBe("https://uploads.acme.ghe.com/user-attachments/assets");
  });

  it("refuses GitHub Enterprise Server, as gh does", () => {
    expect(() => uploadEndpoint("github.acme.internal")).toThrow(/not supported on GitHub Enterprise Server/);
  });
});
