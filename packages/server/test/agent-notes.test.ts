import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { keyToString, parseDiff, readFilesJson, readMeta } from "@reviewer/core";
import { createApp } from "../src/app.js";
import { formatAgentNotes } from "../src/agent-notes.js";
import { addComment, commentEvents, deleteComment, markPickedUp, pendingAgentNotes, readComments, readDeletedComments, restoreDeletedComment, setCommentAudience, undoCommentEdit, updateCommentBody, writeComments, type Comment } from "../src/comments.js";
import { runNotesCommand } from "../src/notes-command.js";
import { buildFixture, key } from "./fixtures.js";

let root: string;
let app: ReturnType<typeof createApp>;
const url = `/api/prs/${encodeURIComponent(keyToString(key))}/agent-notes`;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-notes-"));
  buildFixture(root);
  app = createApp({ stateDir: root, webDist: path.join(root, "none") });
});
afterEach(() => { vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }); });
const add = (extra = {}) => addComment(key, { file: "src/foo.ts", line: 2, side: "RIGHT", body: "Please fix\nthis", audience: "agent", ...extra }, root);
const pickup = (wait = 0, signal?: AbortSignal) => app.request(`${url}/pickup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: "Codex", wait }), signal });
const format = (notes: Comment[]) => formatAgentNotes(notes, { meta: readMeta(key, root), revision: 1, files: readFilesJson(key, 1, root).files });

it("formats ranges, side-specific context, file notes, replies and missing anchors", () => {
  const parent = add({ startLine: 1 });
  const reply = add({ inReplyTo: parent.id, body: "Reply\nwords" });
  const left = add({ side: "LEFT" });
  const file = addComment(key, { file: "z.json", body: "Whole file", audience: "agent" }, root);
  const missing = add({ line: 999 });
  const md = format([parent, left, reply, file, missing]);
  expect(md).toContain("# Notes from the reviewer — acme/widgets#7 (revision 1)");
  const withCommit = formatAgentNotes([parent], { meta: readMeta(key, root), revision: 1, headSha: "1a2b3c4d5e6f7a8b9c0d", files: readFilesJson(key, 1, root).files });
  expect(withCommit).toContain("# Notes from the reviewer — acme/widgets#7 (revision 1, commit 1a2b3c4d5e6f)");
  expect(md).toContain("5 notes.");
  expect(md).toContain("## 1. src/foo.ts:1-2\n\n```ts\nline1\nnew2\nline3\n```");
  expect(md).toContain("> Please fix\n> this\n\n### reply\n\n> Reply\n> words\n\n## 2.");
  expect(md).toContain("```ts\nline1\nold2\nline3\n```");
  expect(md).toContain("z.json (file)\n\n> Whole file");
  expect(md).toContain("(line no longer in current diff)");
  expect(format([])).toBe("");
});

it("sorts pending notes by file, file-level then line, excluding github and picked-up notes", () => {
  const line = add();
  const file = addComment(key, { file: "src/foo.ts", body: "file", audience: "agent" }, root);
  add({ audience: "github" });
  const delivered = add();
  markPickedUp(key, [delivered.id], "Codex", root);
  expect(pendingAgentNotes(readComments(key, root)).map((n) => n.id)).toEqual([file.id, line.id]);
});

it("peek never marks; pickup marks once; an edit is redelivered, a move to GitHub withdrawn", async () => {
  const note = add();
  add({ audience: "github" });
  const peek = await (await app.request(url)).json();
  expect(peek.pending).toHaveLength(1);
  expect(readComments(key, root)[0].pickedUp).toBeUndefined();
  const result = await (await pickup()).json();
  expect(result.notes).toHaveLength(1);
  expect(result.notes[0]).toMatchObject({ kind: "new", pickedUp: { by: "Codex", body: "Please fix\nthis" } });
  expect(result.withdrawn).toEqual([]);
  expect(result.revision).toBe(1);
  expect(await (await pickup()).json()).toEqual({ notes: [], withdrawn: [], markdown: "", revision: 1 });
  updateCommentBody(key, note.id, "changed", root);
  expect(readComments(key, root)[0].pickedUp).toBeUndefined();
  expect((await (await pickup()).json()).notes).toHaveLength(1);
  setCommentAudience(key, note.id, "github", root);
  expect(readComments(key, root)[0].pickedUp).toBeUndefined();
  const moved = await (await pickup()).json();
  expect(moved.notes).toEqual([]);
  expect(moved.withdrawn).toEqual([expect.objectContaining({ id: note.id, reason: "moved-to-github", body: "changed" })]);
});

it("an edit after pickup is delivered once, as an edit, quoting what the agent was handed", async () => {
  const note = add();
  await pickup();
  updateCommentBody(key, note.id, "Fix it differently", root);
  updateCommentBody(key, note.id, "Fix it like this", root);
  const peek = await (await app.request(url)).json();
  expect(peek.pending).toEqual([expect.objectContaining({ id: note.id, kind: "edited", previousBody: "Please fix\nthis" })]);
  expect(peek.pending[0]).not.toHaveProperty("previousPickup");
  const result = await (await pickup()).json();
  expect(result.notes).toEqual([expect.objectContaining({ kind: "edited", previousBody: "Please fix\nthis", body: "Fix it like this" })]);
  expect(result.markdown).toContain("1 of them edit a note you picked up earlier");
  expect(result.markdown).toContain("Edited: replaces the note on `src/foo.ts:2` you picked up earlier. It said:\n\n> Please fix\n> this\n\nIt now says:\n\n> Fix it like this");
  expect(readComments(key, root)[0]).toMatchObject({ pickedUp: { body: "Fix it like this" } });
  expect(readComments(key, root)[0].previousPickup).toBeUndefined();
  expect((await (await pickup()).json()).notes).toEqual([]);
});

it("an undo after pickup is an edit; undone back to the text picked up, nothing is redelivered", async () => {
  const note = add();
  updateCommentBody(key, note.id, "second", root);
  await pickup();
  expect(undoCommentEdit(key, note.id, root).ok).toBe(true);
  const result = await (await pickup()).json();
  expect(result.notes).toEqual([expect.objectContaining({ kind: "edited", previousBody: "second", body: "Please fix\nthis" })]);
  updateCommentBody(key, note.id, "third", root);
  undoCommentEdit(key, note.id, root);
  expect(readComments(key, root)[0].pickedUp?.body).toBe("Please fix\nthis");
  expect((await (await pickup()).json()).notes).toEqual([]);
});

it("a mark from before bodies were kept reads the current body as the one picked up", async () => {
  const note = add();
  const comments = readComments(key, root);
  comments[0] = { ...comments[0], pickedUp: { at: new Date().toISOString(), by: "Codex" } };
  writeComments(key, comments, root);
  updateCommentBody(key, note.id, "new text", root);
  expect((await (await pickup()).json()).notes).toEqual([expect.objectContaining({ kind: "edited", previousBody: "Please fix\nthis" })]);
});

it("a delete after pickup is withdrawn once; restoring it afterwards delivers it as a new note", async () => {
  const note = add();
  await pickup();
  updateCommentBody(key, note.id, "edited, not yet delivered", root);
  await deleteComment(key, note.id, root);
  const result = await (await pickup()).json();
  expect(result.notes).toEqual([]);
  expect(result.withdrawn).toEqual([{ id: note.id, reason: "deleted", file: "src/foo.ts", subjectType: "line", line: 2, side: "RIGHT", body: "Please fix\nthis" }]);
  expect(result.markdown).toContain("1 withdrawn:");
  expect(result.markdown).toContain("## 1. Withdrawn: src/foo.ts:2\n\nWithdrawn: ignore the note on `src/foo.ts:2` you picked up earlier (the reviewer deleted it). It said:\n\n> Please fix\n> this");
  expect(readDeletedComments(key, root)[0].withdrawnAt).toBeDefined();
  expect(await (await pickup()).json()).toMatchObject({ notes: [], withdrawn: [], markdown: "" });
  restoreDeletedComment(key, note.id, root);
  expect((await (await pickup()).json()).notes).toEqual([expect.objectContaining({ id: note.id, kind: "new", body: "edited, not yet delivered" })]);
});

it("restoring a deleted note before its withdrawal went out leaves the agent's copy standing", async () => {
  const note = add();
  await pickup();
  await deleteComment(key, note.id, root);
  restoreDeletedComment(key, note.id, root);
  expect(await (await pickup()).json()).toMatchObject({ notes: [], withdrawn: [] });
});

it("a move to GitHub after pickup is withdrawn once; moved back unchanged, nothing is sent", async () => {
  const note = add();
  await pickup();
  setCommentAudience(key, note.id, "github", root);
  setCommentAudience(key, note.id, "agent", root);
  expect(readComments(key, root)[0].pickedUp?.by).toBe("Codex");
  expect(await (await pickup()).json()).toMatchObject({ notes: [], withdrawn: [] });
  setCommentAudience(key, note.id, "github", root);
  const result = await (await pickup()).json();
  expect(result.withdrawn).toEqual([expect.objectContaining({ id: note.id, reason: "moved-to-github" })]);
  expect(result.markdown).toContain("(the reviewer moved it to the GitHub review)");
  expect(readComments(key, root)[0].previousPickup).toBeUndefined();
  expect((await (await pickup()).json()).withdrawn).toEqual([]);
  setCommentAudience(key, note.id, "agent", root);
  expect((await (await pickup()).json()).notes).toEqual([expect.objectContaining({ kind: "new" })]);
});

it("edits and deletes before pickup deliver the latest text or nothing", async () => {
  const edited = add();
  const gone = add({ line: 1 });
  updateCommentBody(key, edited.id, "latest", root);
  await deleteComment(key, gone.id, root);
  setCommentAudience(key, add({ line: 3 }).id, "github", root);
  const result = await (await pickup()).json();
  expect(result.notes).toEqual([expect.objectContaining({ id: edited.id, kind: "new", body: "latest" })]);
  expect(result.notes[0]).not.toHaveProperty("previousBody");
  expect(result.withdrawn).toEqual([]);
  expect(result.markdown).not.toContain("Edited:");
});

it("peek shows edits and withdrawals without marking them", async () => {
  const kept = add();
  const gone = add({ line: 1 });
  await pickup();
  updateCommentBody(key, kept.id, "changed", root);
  await deleteComment(key, gone.id, root);
  for (let i = 0; i < 2; i++) {
    const peek = await (await app.request(url)).json();
    expect(peek.pending).toEqual([expect.objectContaining({ kind: "edited" })]);
    expect(peek.withdrawn).toEqual([expect.objectContaining({ id: gone.id })]);
  }
  const run = cli([keyToString(key), "--peek"]);
  expect(await run.result).toBe(0);
  expect(run.print).toHaveBeenCalledWith(expect.stringContaining("Withdrawn:"));
  expect(readDeletedComments(key, root)[0].withdrawnAt).toBeUndefined();
  expect(readComments(key, root)[0].previousPickup).toBeDefined();
});

it("waits for a withdrawal of a picked-up note", async () => {
  const note = add();
  await pickup();
  const baseline = commentEvents.listenerCount("comments");
  const response = pickup(30);
  await vi.waitFor(() => expect(commentEvents.listenerCount("comments")).toBe(baseline + 1));
  await deleteComment(key, note.id, root);
  expect((await (await response).json()).withdrawn).toHaveLength(1);
  expect(commentEvents.listenerCount("comments")).toBe(baseline);
});

it("waits for an addComment wake and removes its listener", async () => {
  const baseline = commentEvents.listenerCount("comments");
  const response = pickup(30);
  await vi.waitFor(() => expect(commentEvents.listenerCount("comments")).toBe(baseline + 1));
  add({ audience: "github" });
  expect(commentEvents.listenerCount("comments")).toBe(baseline + 1);
  add();
  expect((await (await response).json()).notes).toHaveLength(1);
  expect(commentEvents.listenerCount("comments")).toBe(baseline);
});

it("caps the wait at 30 seconds and cleans up on timeout", async () => {
  vi.useFakeTimers();
  const baseline = commentEvents.listenerCount("comments");
  const response = pickup(100);
  await vi.advanceTimersByTimeAsync(0);
  expect(commentEvents.listenerCount("comments")).toBe(baseline + 1);
  await vi.advanceTimersByTimeAsync(30_000);
  expect((await (await response).json()).notes).toEqual([]);
  expect(commentEvents.listenerCount("comments")).toBe(baseline);
});

it("cleans up on abort without marking", async () => {
  const baseline = commentEvents.listenerCount("comments");
  const controller = new AbortController();
  const response = pickup(30, controller.signal);
  await vi.waitFor(() => expect(commentEvents.listenerCount("comments")).toBe(baseline + 1));
  controller.abort();
  await response;
  expect(commentEvents.listenerCount("comments")).toBe(baseline);
  add();
  expect(pendingAgentNotes(readComments(key, root))).toHaveLength(1);
});

it("rejects unknown PRs and invalid pickup bodies", async () => {
  expect((await app.request(url.replace("%2F7", "%2F999"))).status).toBe(404);
  expect((await app.request(`${url}/pickup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"agent":""}' })).status).toBe(400);
});

const injected: typeof fetch = (input, init) => app.request(String(input), init);
const cli = (args: string[], request = injected, sleep?: (ms: number) => Promise<void>) => {
  const print = vi.fn();
  return { print, result: runNotesCommand(args, { port: 4779, fetch: request, print, sleep }) };
};
it("CLI picks up once with the named agent and supports PR URLs", async () => {
  add();
  const run = cli(["https://github.com/acme/widgets/pull/7", "--agent", "Claude Code"]);
  expect(await run.result).toBe(0);
  expect(run.print).toHaveBeenCalledWith(expect.stringContaining("Notes from the reviewer"));
  expect(readComments(key, root)[0].pickedUp?.by).toBe("Claude Code");
  const empty = cli([keyToString(key)]);
  expect(await empty.result).toBe(0);
  expect(empty.print).toHaveBeenCalledWith("No new notes for the agent.");
});
it("CLI peek reads without marking even with --wait", async () => {
  add();
  const run = cli([keyToString(key), "--peek", "--wait"]);
  expect(await run.result).toBe(0);
  expect(run.print).toHaveBeenCalledWith(expect.stringContaining("Notes from the reviewer"));
  expect(readComments(key, root)[0].pickedUp).toBeUndefined();
});
it("CLI loops 30-second pickup requests until notes arrive", async () => {
  const bodies: unknown[] = [];
  const request: typeof fetch = async (input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) return Response.json({ notes: [], markdown: "", revision: 1 });
    add();
    return injected(input, init);
  };
  const run = cli([keyToString(key), "--wait", "--agent", "Tester"], request, async () => {});
  expect(await run.result).toBe(0);
  expect(bodies).toEqual([{ agent: "Tester", wait: 30 }, { agent: "Tester", wait: 30 }]);
});
it("CLI reports connection refused and unknown PR", async () => {
  const refused = cli([keyToString(key)], async () => { throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }); });
  expect(await refused.result).toBe(1);
  expect(refused.print).toHaveBeenCalledWith("Purview is not running on port 4779.");
  const unknown = cli(["github.com/acme/widgets/999"]);
  expect(await unknown.result).toBe(1);
  expect(unknown.print).toHaveBeenCalledWith(expect.stringContaining("PR is not tracked"));
});

it("clips context to two lines and uses an empty language for unknown extensions", () => {
  const patch = "diff --git a/a.unknown b/a.unknown\n--- a/a.unknown\n+++ b/a.unknown\n@@ -1,9 +1,9 @@\n" + Array.from({ length: 9 }, (_, i) => ` line${i + 1}`).join("\n") + "\n";
  const note = add({ file: "a.unknown", line: 5 });
  const md = formatAgentNotes([note], { meta: key, revision: 3, files: parseDiff(patch) });
  expect(md).toContain("```\nline3\nline4\nline5\nline6\nline7\n```");
  expect(md).not.toContain("line2");
  expect(md).not.toContain("line8");
});

it("streams comment changes to the open PR and unsubscribes on abort", async () => {
  const baseline = commentEvents.listenerCount("comments");
  const controller = new AbortController();
  const response = await app.request(url.replace("/agent-notes", "/events"), { signal: controller.signal });
  const reader = response.body!.getReader();
  await reader.read(); // initial job snapshot
  add();
  const frame = new TextDecoder().decode((await reader.read()).value);
  expect(frame).toContain("event: comments");
  controller.abort();
  await reader.cancel();
  await vi.waitFor(() => expect(commentEvents.listenerCount("comments")).toBe(baseline));
});
