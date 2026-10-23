import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { setGhAsyncRunner, setGhRunner } from "@reviewer/core";
import { createApp } from "../src/app.js";
import { resetViewerLoginCache } from "../src/github-review.js";
import { clearStalenessCache } from "../src/staleness.js";
import { buildFixture, key } from "./fixtures.js";

let root: string;
afterEach(() => {
  setGhAsyncRunner(null);
  setGhRunner(null);
  resetViewerLoginCache();
  clearStalenessCache();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

it.each(["threads", "staleness", "review"])("serves another request while /%s waits for gh", async (endpoint) => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-async-gh-"));
  buildFixture(root);
  const app = createApp({ stateDir: root, webDist: path.join(root, "no-web") });
  let release!: (value: string) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<string>(resolve => { release = resolve; });
  setGhRunner(() => { throw new Error("Unexpected synchronous gh on request path"); });
  setGhAsyncRunner(() => { entered(); return pending; });
  const url = `/api/prs/${encodeURIComponent(`${key.host}/${key.owner}/${key.repo}/${key.number}`)}`;
  let finished = false;
  const request = app.request(`${url}/${endpoint}`).then(res => { finished = true; return res; });
  await started;
  try {
    expect((await app.request(`${url}/analysis-job`)).status).toBe(200);
    expect(finished).toBe(false);
  } finally {
    release("{}");
  }
  expect((await request).status).toBe(200);
});
