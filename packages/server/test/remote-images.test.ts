import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setGhRunner } from "@reviewer/core";
import { createApp } from "../src/app.js";
import {
  MAX_REMOTE_IMAGE_BYTES,
  allowedRemoteImageUrl,
  readRemoteImages,
  remoteImageFilePath,
  resetGithubTokenCache,
} from "../src/remote-images.js";
import { buildFixture, key } from "./fixtures.js";
import { fakeGh, type FakeGh } from "./fake-gh.js";

const encodedKey = encodeURIComponent(`${key.host}/${key.owner}/${key.repo}/${key.number}`);
const ASSET = "https://github.com/user-attachments/assets/781ee3de-20de-47ab-8119-e12c5d8778b5";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("purview")]);

let root: string;
let app: ReturnType<typeof createApp>;
let gh: FakeGh;
let fetchMock: ReturnType<typeof vi.fn>;

/** What the mocked GitHub answers: a Response per call, in order (the last one repeats). */
function answer(...responses: (() => Response)[]) {
  let i = 0;
  fetchMock = vi.fn(async () => responses[Math.min(i++, responses.length - 1)]());
  vi.stubGlobal("fetch", fetchMock);
}

const png = (bytes: Buffer = PNG, headers: Record<string, string> = {}) => () =>
  new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": "image/png", ...headers } });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-remote-images-test-"));
  buildFixture(root);
  app = createApp({ stateDir: root, webDist: path.join(root, "__no-web-dist__") });
  gh = fakeGh();
  gh.install();
  resetGithubTokenCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  setGhRunner(null);
  fs.rmSync(root, { recursive: true, force: true });
});

const get = (url: string) => app.request(`/api/prs/${encodedKey}/image?url=${encodeURIComponent(url)}`);

describe("allowlist", () => {
  it("accepts GitHub's image hosts only", () => {
    const ok = [
      ASSET,
      "https://github.com/acme/billing/assets/123/abc-def.png",
      "https://private-user-images.githubusercontent.com/1/2-abc.png?jwt=x",
      "https://user-images.githubusercontent.com/1/2.png",
      "https://camo.githubusercontent.com/abcdef/1234",
    ];
    for (const u of ok) expect(allowedRemoteImageUrl(u)?.href, u).toBe(u);
    const no = [
      "https://example.com/a.png",
      "http://github.com/user-attachments/assets/x",
      "https://github.com/acme/billing/pull/1",
      "https://github.com/user-attachments/assets/",
      "https://evil.githubusercontent.com/x",
      "https://user@github.com/user-attachments/assets/x",
      "not a url",
    ];
    for (const u of no) expect(allowedRemoteImageUrl(u), u).toBeNull();
  });

  it("accepts the PR's own GitHub host too", () => {
    expect(allowedRemoteImageUrl("https://ghe.acme.com/user-attachments/assets/x", "ghe.acme.com")).not.toBeNull();
    expect(allowedRemoteImageUrl("https://ghe.acme.com/user-attachments/assets/x")).toBeNull();
  });

  it("the route answers 400 off the allowlist, without fetching", async () => {
    answer(png());
    const res = await get("https://example.com/a.png");
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("remote_image_not_allowed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires ?url", async () => {
    const res = await app.request(`/api/prs/${encodedKey}/image`);
    expect(res.status).toBe(400);
  });
});

describe("proxy", () => {
  it("fetches with the gh token as Bearer, serves the bytes and caches them", async () => {
    answer(png());
    const res = await get(ASSET);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ASSET);
    expect(init.redirect).toBe("follow");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer gho_fake_token");
    expect(gh.calls).toContainEqual(["auth", "token"]);

    const [stored] = readRemoteImages(key, root);
    expect(stored).toMatchObject({ url: ASSET, mime: "image/png", ext: ".png", size: PNG.length });
    expect(fs.readFileSync(remoteImageFilePath(key, stored, root))).toEqual(PNG);

    // Second request: from disk, GitHub is not asked again.
    const again = await get(ASSET);
    expect(again.status).toBe(200);
    expect(Buffer.from(await again.arrayBuffer())).toEqual(PNG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("asks the gh token once per process", async () => {
    answer(png());
    await get(ASSET);
    await get("https://user-images.githubusercontent.com/1/other.png");
    expect(gh.calls.filter((c) => c[0] === "auth").length).toBe(1);
  });

  it("goes out without credentials when gh has no token", async () => {
    gh.fail("auth token", "not logged in");
    answer(png());
    expect((await get(ASSET)).status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("refuses anything that is not an image or a video", async () => {
    answer(() => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }));
    const res = await get(ASSET);
    expect(res.status).toBe(415);
    expect(readRemoteImages(key, root)).toEqual([]);
  });

  it("serves a video", async () => {
    answer(() => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "video/mp4" } }));
    const res = await get("https://github.com/user-attachments/assets/clip");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(readRemoteImages(key, root)[0].ext).toBe(".mp4");
  });

  it("caps the size, by the declared length and by the bytes", async () => {
    answer(png(PNG, { "content-length": String(MAX_REMOTE_IMAGE_BYTES + 1) }));
    expect((await get(ASSET)).status).toBe(413);

    answer(png(Buffer.alloc(MAX_REMOTE_IMAGE_BYTES + 1)));
    const res = await get(ASSET);
    expect(res.status).toBe(413);
    expect(readRemoteImages(key, root)).toEqual([]);
    expect(fs.existsSync(path.join(root, key.host, key.owner, key.repo, String(key.number), "remote-images"))).toBe(false);
  });

  it("explains a GitHub failure as 502", async () => {
    answer(() => new Response("nope", { status: 404 }));
    const res = await get(ASSET);
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).detail).toMatch(/HTTP 404/);

    fetchMock = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    vi.stubGlobal("fetch", fetchMock);
    const down = await get(ASSET);
    expect(down.status).toBe(502);
    expect(((await down.json()) as any).detail).toMatch(/ECONNRESET/);
  });

  it("sandboxes an SVG", async () => {
    answer(() => new Response("<svg/>", { status: 200, headers: { "content-type": "image/svg+xml" } }));
    const res = await get(ASSET);
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
  });

  it("404s for a PR that is not tracked", async () => {
    answer(png());
    const other = encodeURIComponent("github.com/acme/other/1");
    const res = await app.request(`/api/prs/${other}/image?url=${encodeURIComponent(ASSET)}`);
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
