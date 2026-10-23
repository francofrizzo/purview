import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readMeta } from "@reviewer/core";
import { createApp } from "../src/app.js";
import { buildFixture, key } from "./fixtures.js";
let root: string;
let app: ReturnType<typeof createApp>;
const route = `/api/prs/${encodeURIComponent(`${key.host}/${key.owner}/${key.repo}/${key.number}`)}`;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-tag-test-"));
  buildFixture(root);
  app = createApp({ stateDir: root, webDist: path.join(root, "no-web") });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const post = (body: unknown) => app.request(`${route}/tag`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
it("normalizes, persists, exposes and clears tags preserving other metadata", async () => {
  const before = readMeta(key, root);
  const res = await post({ tag: "  Release \n ONE " });
  expect(res.status).toBe(200);
  expect((await res.json()).tag).toBe("release one");
  expect(readMeta(key, root)).toEqual({ ...before, tag: "release one" });
  expect((await (await app.request(route)).json()).meta.tag).toBe("release one");
  const list = await (await app.request("/api/prs")).json();
  expect(list.prs.find((p: { meta: { number: number } }) => p.meta.number === key.number).meta.tag).toBe("release one");
  expect((await post({ tag: null })).status).toBe(200);
  expect(readMeta(key, root)).toEqual(before);
});
it("rejects invalid tags and accepts the length boundary", async () => {
  for (const body of [{}, null, { tag: "  " }, { tag: "x".repeat(25) }, { tag: 3 }]) expect((await post(body)).status).toBe(400);
  expect((await post({ tag: "x".repeat(24) })).status).toBe(200);
});
