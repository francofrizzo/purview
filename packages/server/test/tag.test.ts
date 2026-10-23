import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readMeta, writeMeta } from "@reviewer/core";
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
it("with stack: true tags every PR linked through bases, skipping archived ones", async () => {
  const base = readMeta(key, root);
  const sibling = { ...base, number: 8, url: base.url.replace(/\d+$/, "8"), basePr: { number: key.number, title: "Add widgets", url: base.url } };
  const top = { ...base, number: 9, url: base.url.replace(/\d+$/, "9"), basePr: { number: 8, title: "eight", url: sibling.url } };
  const shelved = { ...base, number: 10, url: base.url.replace(/\d+$/, "10"), archived: true, basePr: { number: key.number, title: "Add widgets", url: base.url } };
  const unrelated = { ...base, number: 11, url: base.url.replace(/\d+$/, "11") };
  for (const m of [sibling, top, shelved, unrelated]) writeMeta({ ...key, number: m.number }, m, root);
  const res = await app.request(`${route.replace(/\d+$/, "8")}/tag`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tag: "stacked", stack: true }) });
  expect(res.status).toBe(200);
  expect((await res.json()).stack.map((k: string) => Number(k.split("/").pop())).sort()).toEqual([key.number, 8, 9]);
  for (const n of [key.number, 8, 9]) expect(readMeta({ ...key, number: n }, root).tag).toBe("stacked");
  for (const n of [10, 11]) expect(readMeta({ ...key, number: n }, root).tag).toBeUndefined();
  // Without the flag only the one PR changes.
  await post({ tag: "alone" });
  expect(readMeta({ ...key, number: 8 }, root).tag).toBe("stacked");
});
