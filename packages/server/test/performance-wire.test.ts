import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, it } from "vitest";
import { analysisJobPath, keyToString, readFilesJson, updateMeta } from "@reviewer/core";
import { createApp } from "../src/app.js";
import { buildFixture, key } from "./fixtures.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-wire-")); buildFixture(root); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const url = (suffix = "") => `http://localhost:4863/api/prs${suffix}`;
const app = (webDist?: string) => createApp({ stateDir: root, port: 4863, autoAnalyze: false, reviewRequestRefresh: false, updateChecker: false, webDist });

it("slims list metadata and detail hunks without modifying persisted bodies", async () => {
  updateMeta(key, { body: "description omitted from list" }, root);
  fs.writeFileSync(analysisJobPath(key, root), JSON.stringify({ revision: 1, status: "done", metrics: { toolCalls: { Read: 3 } } }));
  const api = app();
  const list = await (await api.request(url())).json();
  expect(list.prs[0].meta).not.toHaveProperty("body");
  expect(list.prs[0].meta).not.toHaveProperty("ci");
  expect(list.prs[0].analysisJob.status).toBe("done");
  expect(list.prs[0].analysisJob).not.toHaveProperty("metrics");
  const detail = await (await api.request(url('/' + encodeURIComponent(keyToString(key))))).json();
  expect(detail.analysisJob.metrics.toolCalls.Read).toBe(3);
  expect(detail.meta.body).toBe("description omitted from list");
  expect(detail.files[0].hunks[0]).not.toHaveProperty("text");
  expect(detail.files[0].hunks[0]).not.toHaveProperty("addedLines");
  expect(detail.files[0].hunks[0]).not.toHaveProperty("removedLines");
  expect(readFilesJson(key, detail.state.currentRevision, root).files[0].hunks[0].text).toBeTruthy();
  const zipped = await api.request(url(), { headers: { "Accept-Encoding": "gzip" } });
  expect(zipped.headers.get("Content-Encoding")).toBe("gzip");
  expect(zipped.headers.get("Vary")).toContain("Accept-Encoding");
  expect(JSON.parse(gunzipSync(Buffer.from(await zipped.arrayBuffer())).toString())).toEqual(list);
});

it("does not compress SSE and delivers the initial event immediately", async () => {
  const response = await app().request(url('/' + encodeURIComponent(keyToString(key)) + '/events'), { headers: { "Accept-Encoding": "gzip" } });
  expect(response.headers.get("Content-Encoding")).toBeNull();
  const reader = response.body!.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain("analysis-job");
  await reader.cancel();
});

it("compresses hashed assets, caches them immutably and revalidates SPA HTML", async () => {
  const dist = path.join(root, 'web');
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  const js = 'console.log("hello");'.repeat(100);
  fs.writeFileSync(path.join(dist, 'assets', 'index-abc.js'), js);
  fs.writeFileSync(path.join(dist, 'index.html'), '<html>app</html>');
  const api = app(dist);
  const asset = await api.request('http://localhost:4863/assets/index-abc.js', { headers: { 'Accept-Encoding': 'gzip' } });
  expect(asset.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  expect(asset.headers.get('Content-Encoding')).toBe('gzip');
  expect(gunzipSync(Buffer.from(await asset.arrayBuffer())).toString()).toBe(js);
  for (const route of ['/', '/index.html', '/pr/example', '/assets/missing.js']) {
    expect((await api.request('http://localhost:4863' + route)).headers.get('Cache-Control')).toBe('no-cache');
  }
});
