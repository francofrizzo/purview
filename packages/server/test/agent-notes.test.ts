import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { keyToString, parseDiff, readFilesJson, readMeta } from "@reviewer/core";
import { createApp } from "../src/app.js";
import { formatAgentNotes } from "../src/agent-notes.js";
import { addComment, commentEvents, markPickedUp, pendingAgentNotes, readComments, setCommentAudience, updateCommentBody, type Comment } from "../src/comments.js";
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

it("peek never marks; pickup marks once; editing and audience changes clear delivery", async () => {
  const note = add();
  add({ audience: "github" });
  const peek = await (await app.request(url)).json();
  expect(peek.pending).toHaveLength(1);
  expect(readComments(key, root)[0].pickedUp).toBeUndefined();
  const result = await (await pickup()).json();
  expect(result.notes).toHaveLength(1);
  expect(result.notes[0].pickedUp.by).toBe("Codex");
  expect(result.revision).toBe(1);
  expect(await (await pickup()).json()).toEqual({ notes: [], markdown: "", revision: 1 });
  updateCommentBody(key, note.id, "changed", root);
  expect(readComments(key, root)[0].pickedUp).toBeUndefined();
  expect((await (await pickup()).json()).notes).toHaveLength(1);
  setCommentAudience(key, note.id, "github", root);
  expect(readComments(key, root)[0].pickedUp).toBeUndefined();
  expect((await (await pickup()).json()).notes).toEqual([]);
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
