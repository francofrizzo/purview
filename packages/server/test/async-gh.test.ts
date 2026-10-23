import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { setGhAsyncRunner, setGhRunner } from "@reviewer/core";
import { createApp } from "../src/app.js";
import { resetViewerLoginCache } from "../src/github-review.js";
import { clearStalenessCache } from "../src/staleness.js";
import { githubToken, resetGithubTokenCache } from "../src/remote-images.js";
import { buildFixture, key } from "./fixtures.js";

let root: string;
afterEach(() => {
  setGhAsyncRunner(null);
  setGhRunner(null);
  resetViewerLoginCache();
  resetGithubTokenCache();
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

it.each(["add", "refresh"])("serves analysis-job while %s waits for gh", async (operation) => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-async-gh-"));
  buildFixture(root);
  const app = createApp({ stateDir: root, webDist: path.join(root, "no-web"), autoAnalyze: false });
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  let syncCalls = 0;
  setGhRunner(() => { syncCalls++; throw new Error("Unexpected synchronous gh on request path"); });
  setGhAsyncRunner(async args => {
    entered();
    await pending;
    if (args.includes("graphql")) return JSON.stringify({ data: { repository: { pullRequest: {} } } });
    if (args.includes("user")) return JSON.stringify({ login: "reader" });
    if (args.includes("user/teams")) return "[]";
    if (args.includes("Accept: application/vnd.github.v3.diff")) return "";
    if (args.some(a => a.includes("/compare/"))) return JSON.stringify({ merge_base_commit: { sha: "base" } });
    if (args.some(a => a.endsWith("/pulls/8") || a.endsWith("/pulls/7"))) {
      return JSON.stringify({ number: operation === "add" ? 8 : 7, node_id: "PR_test", title: "Test", state: "open",
        html_url: "https://github.com/acme/widgets/pull/8", base: { ref: "main", sha: "base" }, head: { ref: "feature", sha: "head" } });
    }
    if (args.some(a => a.endsWith("/timeline"))) return "[]";
    return JSON.stringify({ default_branch: "main" });
  });
  const url = `/api/prs/${encodeURIComponent(`${key.host}/${key.owner}/${key.repo}/${key.number}`)}`;
  let finished = false;
  const request = (operation === "add"
    ? app.request("/api/prs?analyze=false", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "https://github.com/acme/widgets/pull/8" }) })
    : app.request(`${url}/refresh?analyze=false`, { method: "POST" }))
    .then(res => { finished = true; return res; });
  await started;
  try {
    expect((await app.request(`${url}/analysis-job`)).status).toBe(200);
    expect(finished).toBe(false);
  } finally {
    release();
  }
  expect((await request).status).toBe(200);
  expect(syncCalls).toBe(0);
});

it("shares pending image-token reads per host and caches failures", async () => {
  let release!: (token: string) => void;
  const pending = new Promise<string>(resolve => { release = resolve; });
  const calls: string[][] = [];
  setGhAsyncRunner(args => {
    calls.push(args);
    return args.includes("enterprise.example") ? Promise.reject(new Error("not logged in")) : pending;
  });
  const first = githubToken("GitHub.com");
  const second = githubToken("github.com");
  expect(calls).toHaveLength(1);
  release(" secret-token\n");
  expect(await first).toBe("secret-token");
  expect(await second).toBe("secret-token");
  expect(await githubToken("github.com")).toBe("secret-token");
  expect(await githubToken("enterprise.example")).toBeNull();
  expect(await githubToken("enterprise.example")).toBeNull();
  expect(calls).toEqual([["auth", "token"], ["auth", "token", "--hostname", "enterprise.example"]]);
});
