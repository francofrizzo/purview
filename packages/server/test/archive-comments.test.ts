import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { keyToString, setGhRunner } from "@reviewer/core";
import { createApp } from "../src/app.js";
import { addComment, readArchivedComments, readComments, writeComments, type Comment } from "../src/comments.js";
import { buildFixture, key } from "./fixtures.js";
import { fakeGh, type FakeGh } from "./fake-gh.js";

let root: string;
let app: ReturnType<typeof createApp>;
let gh: FakeGh;
const base = `/api/prs/${encodeURIComponent(keyToString(key))}/comments`;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-archive-"));
  buildFixture(root);
  app = createApp({ stateDir: root, webDist: path.join(root, "none") });
  gh = fakeGh();
  gh.install();
});
afterEach(() => {
  setGhRunner(null);
  fs.rmSync(root, { recursive: true, force: true });
});

function req(method: string, url: string, body?: unknown) {
  return app.request(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
function seed(extra: Partial<Comment> = {}): Comment {
  const comment = addComment(key, { file: "src/foo.ts", line: 2, side: "RIGHT", body: "seeded" }, root);
  writeComments(key, readComments(key, root).map((c) => (c.id === comment.id ? { ...c, ...extra } : c)), root);
  return readComments(key, root).find((c) => c.id === comment.id)!;
}

it("archives drafts and pushed comments, never submitted ones, and lists them apart from the review", async () => {
  const draft = seed();
  const pushed = seed({ status: "pushed", githubCommentId: 41, pushedAt: "2026-01-01T00:00:00Z" });
  const submitted = seed({ status: "submitted", githubCommentId: 42, submittedAt: "2026-01-01T00:00:00Z" });

  const res = await req("POST", `${base}/archive`, { ids: [draft.id, pushed.id, submitted.id] });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ archived: [draft.id, pushed.id], skipped: [submitted.id], remoteErrors: [] });
  // The pushed one left the pending review on GitHub first.
  expect(gh.calls.some((args) => args.join(" ").includes("pulls/comments/41"))).toBe(true);
  expect(readComments(key, root).map((c) => c.id)).toEqual([submitted.id]);

  const listed = await (await req("GET", base)).json();
  expect(listed.archived.map((c: Comment) => c.id)).toEqual([draft.id, pushed.id]);
  // Archived as a draft: restoring it pushes it again instead of duplicating it.
  expect(listed.archived[1]).toMatchObject({ status: "draft", archivedAt: expect.any(String) });
  expect(listed.archived[1].githubCommentId).toBeUndefined();
});

it("restores an archived comment as a draft, and deletes one for good", async () => {
  const a = seed();
  const b = seed();
  await req("POST", `${base}/archive`, { ids: [a.id, b.id] });

  const restored = await req("POST", `${base}/archived/${a.id}/restore`);
  expect(restored.status).toBe(200);
  expect(readComments(key, root)).toEqual([expect.objectContaining({ id: a.id, status: "draft", body: "seeded" })]);

  expect((await req("DELETE", `${base}/archived/${b.id}`)).status).toBe(200);
  expect(readArchivedComments(key, root)).toEqual([]);
  expect((await req("DELETE", `${base}/archived/${b.id}`)).status).toBe(404);
  expect((await req("POST", `${base}/archive`, {})).status).toBe(400);
});
