import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendEvent, prDir, prExists, setGhRunner, writeMeta, type GhRunner } from "@reviewer/core";
import { createApp } from "../src/app.js";
import { key, REV1_PATCH } from "./fixtures.js";

let root: string;
let diffFails: boolean;

const ghStub: GhRunner = (args) => {
  const joined = args.join(" ");
  if (joined.includes("v3.diff")) {
    if (diffFails) throw new Error("diff unavailable");
    return REV1_PATCH;
  }
  if (joined.includes("/compare/")) return JSON.stringify({ merge_base_commit: { sha: "mb1" } });
  if (/pulls\/\d+$/.test(args[args.length - 1] ?? "")) {
    return JSON.stringify({
      node_id: "PR_1",
      number: key.number,
      title: "Add widgets",
      html_url: `https://github.com/${key.owner}/${key.repo}/pull/${key.number}`,
      state: "open",
      base: { ref: "main", sha: "base1" },
      head: { ref: "feature", sha: "head1" },
    });
  }
  return "{}";
};

const app = () =>
  createApp({ stateDir: root, webDist: path.join(root, "__no-web-dist__"), autoAnalyze: false });
const prPath = `/api/prs/${encodeURIComponent(`${key.host}/${key.owner}/${key.repo}/${key.number}`)}`;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-unfetched-test-"));
  diffFails = false;
  setGhRunner(ghStub);
});

afterEach(() => {
  setGhRunner(null);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("a PR whose first fetch failed", () => {
  it("is not left behind by a failed add", async () => {
    diffFails = true;
    const res = await app().request("/api/prs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: `https://github.com/${key.owner}/${key.repo}/pull/${key.number}` }),
    });
    expect(res.status).not.toBe(200);
    expect(prExists(key, root)).toBe(false);
    expect(fs.existsSync(prDir(key, root))).toBe(false);
  });

  it("fetches its first revision when opened", async () => {
    // What an add left before adds undid themselves: meta and init, no revision.
    writeMeta(key, {
      host: key.host, owner: key.owner, repo: key.repo, number: key.number,
      url: `https://github.com/${key.owner}/${key.repo}/pull/${key.number}`,
      title: "Add widgets", headRef: "feature", baseRef: "main", archived: false,
      createdAt: "2026-11-12T21:57:00.000Z",
    }, root);
    appendEvent(key, {
      type: "pr-initialized", host: key.host, owner: key.owner, repo: key.repo, number: key.number,
      url: `https://github.com/${key.owner}/${key.repo}/pull/${key.number}`, title: "Add widgets",
    }, root);
    const res = await app().request(prPath);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.state.revisions).toHaveLength(1);
    expect(body.files.map((f: any) => f.path)).toContain("src/foo.ts");
  });
});
