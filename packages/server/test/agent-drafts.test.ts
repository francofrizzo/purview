import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { keyToString, prDir, setGhRunner } from "@reviewer/core";
import { createApp } from "../src/app.js";
import { addComment, readComments, readDeletedComments, writeComments, type Comment } from "../src/comments.js";
import { buildFixture, key } from "./fixtures.js";
import { fakeGh, type FakeGh } from "./fake-gh.js";

let root: string;
let app: ReturnType<typeof createApp>;
let gh: FakeGh;
const base = `/api/prs/${encodeURIComponent(keyToString(key))}/agent`;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-agent-drafts-"));
  buildFixture(root);
  app = createApp({ stateDir: root, webDist: path.join(root, "none") });
  gh = fakeGh();
  gh.install();
});
afterEach(() => {
  setGhRunner(null);
  fs.rmSync(root, { recursive: true, force: true });
});

function req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.request(url, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
const line = { file: "src/foo.ts", line: 2, side: "RIGHT" };
const create = (agent: unknown, extra: Record<string, unknown> = {}) =>
  req("POST", `${base}/drafts`, { agent, ...line, body: "Check new2", ...extra });
/** A comment as it would sit on disk after the given lifecycle step. */
function seed(extra: Partial<Comment>): Comment {
  const comment = addComment(key, { ...line, body: "seeded" }, root, { agent: "claude-code" });
  writeComments(key, readComments(key, root).map(c => (c.id === comment.id ? { ...c, ...extra } : c)), root);
  return readComments(key, root).find(c => c.id === comment.id)!;
}

it("creates a draft authored by the named agent, never by the reader", async () => {
  const res = await create("claude-code", { author: "you", audience: "github" });
  expect(res.status).toBe(201);
  const { comment } = await res.json();
  expect(comment).toMatchObject({ author: { agent: "claude-code" }, status: "draft", audience: "github", line: 2 });
  expect(readComments(key, root)).toEqual([expect.objectContaining({ id: comment.id, author: { agent: "claude-code" } })]);
});

it("anchors a line on the new side unless told otherwise", async () => {
  const res = await req("POST", `${base}/drafts`, { agent: "claude-code", file: "src/foo.ts", line: 2, body: "x" });
  expect((await res.json()).comment).toMatchObject({ side: "RIGHT", subjectType: "line" });
  const file = await req("POST", `${base}/drafts`, { agent: "claude-code", file: "src/foo.ts", body: "whole file" });
  expect((await file.json()).comment).toMatchObject({ subjectType: "file" });
});

it("refuses a draft without a valid agent name or outside the diff", async () => {
  for (const agent of [undefined, "", "you", "Claude Code"]) {
    const res = await create(agent);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_agent");
  }
  const outside = await create("claude-code", { line: 900 });
  expect(outside.status).toBe(422);
  expect((await outside.json()).error).toBe("comment_outside_diff");
  const absent = await create("claude-code", { file: "absent.ts" });
  expect((await absent.json()).error).toBe("comment_outside_diff");
});

it("takes a reply to a GitHub thread as a GitHub draft, even on an outdated line", async () => {
  const res = await create("claude-code", { line: 900, side: "LEFT", inReplyTo: "thread-1", audience: "agent" });
  expect(res.status).toBe(201);
  expect((await res.json()).comment).toMatchObject({ inReplyTo: "thread-1", audience: "github", status: "draft" });
});

it("edits and trashes the agent's own draft", async () => {
  const { comment } = await (await create("claude-code")).json();
  const edit = await req("PATCH", `${base}/drafts/${comment.id}`, { agent: "claude-code", body: "Rechecked" });
  expect(edit.status).toBe(200);
  expect((await edit.json()).comment).toMatchObject({ body: "Rechecked", lastEditedBy: { agent: "claude-code" } });
  const move = await req("PATCH", `${base}/drafts/${comment.id}`, { agent: "claude-code", body: "x", line: 11 });
  expect(move.status).toBe(400);
  expect((await move.json()).error).toBe("invalid_body");
  const del = await req("DELETE", `${base}/drafts/${comment.id}?agent=claude-code`);
  expect(await del.json()).toEqual({ ok: true, trashed: true });
  expect(readComments(key, root)).toEqual([]);
  expect(readDeletedComments(key, root)).toEqual([
    expect.objectContaining({ id: comment.id, body: "Rechecked", deletedBy: { agent: "claude-code" } }),
  ]);
});

it("edits the reader's draft as its own edit, keeping the old text for an undo, and trashes it restorably", async () => {
  const human = addComment(key, { ...line, body: "Mine" }, root);
  const edit = await req("PATCH", `${base}/drafts/${human.id}`, { agent: "claude-code", body: "Changed" });
  expect(edit.status).toBe(200);
  const edited = readComments(key, root).find((c) => c.id === human.id)!;
  // Still the reader's comment, sent under their name; the edit is the agent's.
  expect(edited.author === undefined || edited.author === "you").toBe(true);
  expect(edited).toMatchObject({ body: "Changed", lastEditedBy: { agent: "claude-code" } });
  expect(edited.history?.[0]).toMatchObject({ body: "Mine" });
  const del = await req("DELETE", `${base}/drafts/${human.id}`, { agent: "claude-code" });
  expect(await del.json()).toEqual({ ok: true, trashed: true });
  expect(readDeletedComments(key, root)).toEqual([expect.objectContaining({ id: human.id, deletedBy: { agent: "claude-code" } })]);
});

it("moves a draft between audiences as an undoable edit", async () => {
  const human = addComment(key, { ...line, body: "Mine", audience: "github" }, root);
  const move = await req("PATCH", `${base}/drafts/${human.id}`, { agent: "claude-code", audience: "agent" });
  expect(move.status).toBe(200);
  expect((await move.json()).comment).toMatchObject({ body: "Mine", audience: "agent", lastEditedBy: { agent: "claude-code" } });
  const both = await req("PATCH", `${base}/drafts/${human.id}`, { agent: "claude-code", audience: "github", body: "Mine, sharper" });
  expect((await both.json()).comment).toMatchObject({ body: "Mine, sharper", audience: "github" });
  // Each change is one undo step: the text first, then the move.
  const undo = (id: string) => req("POST", `/api/prs/${encodeURIComponent(keyToString(key))}/comments/${id}/undo-edit`);
  expect((await (await undo(human.id)).json()).comment).toMatchObject({ body: "Mine", audience: "github" });
  expect((await (await undo(human.id)).json()).comment).toMatchObject({ body: "Mine", audience: "agent" });
  expect((await (await undo(human.id)).json()).comment).toMatchObject({ body: "Mine", audience: "github" });
  expect(readComments(key, root)[0].lastEditedBy).toBeUndefined();
  const empty = await req("PATCH", `${base}/drafts/${human.id}`, { agent: "claude-code" });
  expect((await empty.json()).error).toBe("invalid_body");
});

it("edits another agent's draft too", async () => {
  const { comment } = await (await create("codex")).json();
  const edit = await req("PATCH", `${base}/drafts/${comment.id}`, { agent: "claude-code", body: "Changed" });
  expect(edit.status).toBe(200);
  expect(readComments(key, root)).toEqual([
    expect.objectContaining({ id: comment.id, body: "Changed", author: { agent: "codex" }, lastEditedBy: { agent: "claude-code" } }),
  ]);
});

it("refuses to edit or delete a comment once pushed or submitted", async () => {
  const pushed = seed({ status: "pushed", githubCommentId: 41, pushedAt: "2026-01-01T00:00:00Z" });
  const submitted = seed({ status: "submitted", githubCommentId: 42, submittedAt: "2026-01-01T00:00:00Z" });
  for (const target of [pushed, submitted]) {
    for (const res of [
      await req("PATCH", `${base}/drafts/${target.id}`, { agent: "claude-code", body: "Changed" }),
      await req("DELETE", `${base}/drafts/${target.id}`, { agent: "claude-code" }),
    ]) {
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("not_draft");
    }
  }
  expect(readComments(key, root).map(c => c.body)).toEqual(["seeded", "seeded"]);
  expect(gh.calls).toEqual([]);
});

it("404s an unknown draft or an untracked PR", async () => {
  const missing = await req("PATCH", `${base}/drafts/nope`, { agent: "claude-code", body: "x" });
  expect(missing.status).toBe(404);
  const other = `/api/prs/${encodeURIComponent("github.com/acme/other/1")}/agent/comments`;
  expect((await req("GET", other)).status).toBe(404);
});

it("keeps the review chat out of the agent routes", async () => {
  const res = await req("POST", `${base}/drafts`, { agent: "claude-code", ...line, body: "x" }, { "X-Purview-Actor": "chat" });
  expect(res.status).toBe(403);
  expect((await res.json()).error).toBe("forbidden_actor");
});

it("reads every local comment", async () => {
  const human = addComment(key, { ...line, body: "Mine" }, root);
  const { comment } = await (await create("claude-code")).json();
  const res = await req("GET", `${base}/comments`);
  expect((await res.json()).comments.map((c: Comment) => c.id)).toEqual([human.id, comment.id]);
});

it("reads cached GitHub threads without calling gh", async () => {
  const empty = await (await req("GET", `${base}/threads`)).json();
  expect(empty).toMatchObject({ threads: [], error: "no_threads_cache" });
  const author = { login: "reader", bot: false };
  const thread = { id: "thread-1", path: "src/foo.ts", line: 2, isResolved: false, isOutdated: false,
    comments: [{ author, isMine: true, createdAt: "yesterday", body: "Why new2?" }] };
  fs.writeFileSync(path.join(prDir(key, root), "threads.json"), JSON.stringify({ fetchedAt: "today",
    threads: [thread, { ...thread, id: "thread-2", path: "else.ts", isResolved: true }],
    reviews: [{ author, state: "COMMENTED", submittedAt: "today", body: "A few things" }] }));
  const all = await (await req("GET", `${base}/threads`)).json();
  expect(all).toMatchObject({ fetchedAt: "today", reviews: [{ author: "reader", body: "A few things" }] });
  expect(all.threads.map((t: { id: string }) => t.id)).toEqual(["thread-1", "thread-2"]);
  const open = await (await req("GET", `${base}/threads?only=unresolved&path=src/foo.ts`)).json();
  expect(open.threads).toEqual([expect.objectContaining({ id: "thread-1", comments: [expect.objectContaining({ body: "Why new2?" })] })]);
  expect(gh.calls).toEqual([]);
});
