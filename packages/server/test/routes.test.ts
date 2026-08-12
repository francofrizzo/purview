import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setGhRunner } from "@reviewer/core";
import { createApp } from "../src/app.js";
import { buildFixture, key } from "./fixtures.js";

const encodedKey = encodeURIComponent(`${key.host}/${key.owner}/${key.repo}/${key.number}`);

let root: string;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-server-test-"));
  buildFixture(root);
  app = createApp({ stateDir: root, webDist: path.join(root, "__no-web-dist__") });
});

afterEach(() => {
  setGhRunner(null);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("GET /api/prs", () => {
  it("lists PRs with meta and progress rollup", async () => {
    const res = await app.request("/api/prs");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prs).toHaveLength(1);
    const pr = body.prs[0];
    expect(pr.key).toBe(`${key.host}/${key.owner}/${key.repo}/${key.number}`);
    expect(pr.meta.title).toBe("Add widgets");
    expect(pr.progress.hunks.total).toBe(2);
    expect(pr.progress.hunks.viewed).toBe(0);
    expect(pr.progress.units.total).toBe(1);
  });
});

describe("GET /api/prs/:key", () => {
  it("returns state, current-revision files, diff text and meta", async () => {
    const res = await app.request(`/api/prs/${encodedKey}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.title).toBe("Add widgets");
    expect(body.state.currentRevision).toBe(1);
    expect(body.files).toHaveLength(1);
    expect(body.files[0].path).toBe("src/foo.ts");
    expect(body.diff).toContain("diff --git a/src/foo.ts");
  });

  it("404s with a JSON error for an unknown PR", async () => {
    const otherKey = encodeURIComponent("github.com/acme/other/1");
    const res = await app.request(`/api/prs/${otherKey}`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });
});

describe("hunk viewed toggle", () => {
  it("marks a hunk viewed and rolls the file up to viewed once all hunks are viewed", async () => {
    const stateRes = await app.request(`/api/prs/${encodedKey}`);
    const { state } = await stateRes.json();
    const hunkIds: string[] = state.files[0].hunkIds;
    expect(hunkIds).toHaveLength(2);

    const res1 = await app.request(`/api/prs/${encodedKey}/hunks/${hunkIds[0]}/viewed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ viewed: true }),
    });
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    const rollup1 = body1.state.files.find((f: { path: string }) => f.path === "src/foo.ts");
    expect(rollup1.viewedCount).toBe(1);
    expect(rollup1.viewed).toBe(false);

    const res2 = await app.request(`/api/prs/${encodedKey}/hunks/${hunkIds[1]}/viewed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ viewed: true }),
    });
    const body2 = await res2.json();
    const rollup2 = body2.state.files.find((f: { path: string }) => f.path === "src/foo.ts");
    expect(rollup2.viewedCount).toBe(2);
    expect(rollup2.viewed).toBe(true);
  });

  it("rejects a body without a boolean `viewed`", async () => {
    const res = await app.request(`/api/prs/${encodedKey}/hunks/whatever/viewed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("refresh error surface", () => {
  it("turns a gh failure into a clean JSON error instead of crashing", async () => {
    setGhRunner(() => {
      throw new Error("gh api repos/acme/widgets/pulls/7 failed: HTTP 503 Service Unavailable");
    });
    const res = await app.request(`/api/prs/${encodedKey}/refresh`, { method: "POST" });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("gh_failed");
    expect(body.detail).toContain("failed");
  });
});

describe("comments CRUD", () => {
  it("creates, lists and deletes local draft comments", async () => {
    const createRes = await app.request(`/api/prs/${encodedKey}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: "src/foo.ts", line: 2, side: "RIGHT", body: "Why?" }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()).comment;
    expect(created.status).toBe("draft");
    expect(created.id).toBeTruthy();

    const listRes = await app.request(`/api/prs/${encodedKey}/comments`);
    const listed = (await listRes.json()).comments;
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(created.id);

    const deleteRes = await app.request(`/api/prs/${encodedKey}/comments/${created.id}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(200);

    const listAfter = (await (await app.request(`/api/prs/${encodedKey}/comments`)).json())
      .comments;
    expect(listAfter).toHaveLength(0);
  });

  it("404s deleting a comment that does not exist", async () => {
    const res = await app.request(`/api/prs/${encodedKey}/comments/nope`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("rejects a comment with an empty body", async () => {
    const res = await app.request(`/api/prs/${encodedKey}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: "src/foo.ts", line: 2, side: "RIGHT", body: "" }),
    });
    expect(res.status).toBe(400);
  });
});
