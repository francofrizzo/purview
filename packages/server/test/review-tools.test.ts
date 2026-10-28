import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync, spawn } from "node:child_process";
import { serve, type ServerType } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { prDir, readMeta, writeMeta, loadState, keyToString, writeRevision, appendEvent, parseDiff, toRevisionFiles } from "@reviewer/core";
import { createApp } from "../src/app.js";
import { readComments, readDeletedComments, addComment, writeComments } from "../src/comments.js";
import { createReviewOperations } from "../src/agent/review-tools/operations.js";
import { startReviewTools } from "../src/agent/review-tools/run.js";
import { reviewSystemPrompt } from "../src/agent/review-tools/prompts.js";
import { getHarness, harnessIds } from "../src/agent/registry.js";
import { buildFixture, key, REV2_PATCH } from "./fixtures.js";
import type { AgentRunRequest } from "../src/agent/types.js";
import { codexHarness, setCodexSpawner } from "../src/agent/codex/index.js";

let root: string;
let checkout: string;
let hunkIds: string[];
let http: ServerType | undefined;
let binding: Awaited<ReturnType<typeof startReviewTools>> | undefined;
let client: Client | undefined;
const request = (task: "analysis" | "chat", extra = {}): AgentRunRequest => ({
  task: task === "analysis" ? { kind: task, scratchDir: root, reviewerCommands: [] } : { kind: task, reviewerCommands: [] },
  review: { root, key, revision: 1, checkout, analysisMode: "initial", ...extra },
  cwd: checkout, prompt: "review", model: "test",
});
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-review-tools-"));
  ({ hunkIds } = buildFixture(root));
  checkout = path.join(root, "checkout");
  fs.mkdirSync(path.join(checkout, "src"), { recursive: true });
  fs.writeFileSync(path.join(checkout, "src/foo.ts"), "needle\nother\nneedle\n");
  execFileSync("git", ["init", "-q", checkout]);
  execFileSync("git", ["-C", checkout, "add", "src/foo.ts"]);
});
afterEach(async () => {
  await client?.close(); client = undefined;
  await binding?.close(); binding = undefined;
  if (http) { http.closeAllConnections(); await new Promise<void>(resolve => http!.close(() => resolve())); http = undefined; }
  fs.rmSync(root, { force: true, recursive: true });
});
function nextRevision() {
  const files = parseDiff(REV2_PATCH);
  const shas = { baseSha: "base2", headSha: "head2", mergeBase: "mb2" };
  writeRevision(key, 2, REV2_PATCH, files, shas, root);
  appendEvent(key, { type: "revision-added", revision: 2, ...shas, baseOnly: false, files: toRevisionFiles(files) }, root);
}
function analysis() { return { summary: "Change foo", units: [{ id: "foo", title: "Change foo", summary: "The value changes",
  kind: "core-logic", attention: "must-read", attentionWhy: "Behavior changes", order: 0, hunks: hunkIds }], unassigned: [] }; }

it("uses task-scoped authority, real persisted analysis and fresh revision bindings", async () => {
  const ops = createReviewOperations(request("analysis"), "test");
  await expect(ops.execute("create_draft", {})).rejects.toMatchObject({ code: "operation_not_granted" });
  await expect(ops.execute("patch_units", {})).rejects.toMatchObject({ code: "operation_not_granted" });
  await ops.execute("set_analysis", analysis());
  expect(loadState(key, root).summary).toBe("Change foo");
  nextRevision();
  await expect(ops.execute("set_analysis", analysis())).rejects.toMatchObject({ code: "stale_revision" });
  const fresh = createReviewOperations({ ...request("analysis"), review: { ...request("analysis").review!, revision: 2, analysisMode: "incremental" } }, "test");
  await expect(fresh.execute("set_analysis", analysis())).rejects.toMatchObject({ code: "operation_not_granted" });
  await fresh.execute("patch_units", { units: [{ id: "foo", patch: { summary: "Rechecked revision two" } }] });
  expect(loadState(key, root).units.find(u => u.id === "foo")?.summary).toBe("Rechecked revision two");
  await fresh.execute("set_revision_summary", { text: "Changed the first value again" });
  ops.revoke(); fresh.revoke();
  await expect(fresh.execute("review_context")).rejects.toMatchObject({ code: "revoked" });
});

it("paginates with source lines, rejects mismatched cursors and confines real paths", async () => {
  const ops = createReviewOperations(request("chat"), "test");
  const first = await ops.execute("read_code", { path: "src/foo.ts", limit: 2 }) as any;
  expect(first.items.map((l: any) => l.text)).toEqual(["needle", "other"]);
  const second = await ops.execute("read_code", { path: "src/foo.ts", cursor: first.nextCursor }) as any;
  expect(second.items[0]).toMatchObject({ line: 3, text: "needle" });
  await expect(ops.execute("read_code", { path: "src/foo.ts", start: 2, cursor: first.nextCursor })).rejects.toMatchObject({ code: "stale_cursor" });
  fs.writeFileSync(path.join(root, "private"), "private sentinel");
  fs.symlinkSync(path.join(root, "private"), path.join(checkout, "escape"));
  fs.symlinkSync(path.join(checkout, ".git/config"), path.join(checkout, "git-alias"));
  for (const name of ["../private", "escape", ".git/config", "git-alias"]) {
    await expect(ops.execute("read_code", { path: name })).rejects.toMatchObject({ code: "outside_checkout" });
  }
  const found = await ops.execute("search_code", { patterns: ["needle"], context: 0 }) as any;
  expect(found.items.map((m: any) => m.line)).toEqual([1, 3]);
  await expect(ops.execute("set_analysis", analysis())).rejects.toMatchObject({ code: "operation_not_granted" });
});

it("serves the actual MCP protocol with strict capability URLs and revocation", async () => {
  const outcomes: unknown[] = [];
  binding = await startReviewTools(request("analysis"), "test", undefined, result => outcomes.push(result));
  client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(binding.url)));
  const tools = await client.listTools();
  expect(tools.tools.some(t => t.name === "set_analysis")).toBe(true);
  const result = await client.callTool({ name: "review_context", arguments: {} });
  expect(JSON.parse((result.content as any)[0].text)).toMatchObject({ revision: 1, checkoutAvailable: true });
  const saved = await client.callTool({ name: "set_analysis", arguments: analysis() });
  expect(saved.isError).toBe(false);
  expect(loadState(key, root).summary).toBe("Change foo");
  const denied = await client.callTool({ name: "publish", arguments: {} });
  expect(denied.isError).toBe(true);
  const missing = await client.callTool({ name: "read_code", arguments: { path: "src/missing.ts" } });
  expect(missing.isError).toBe(true);
  expect(JSON.stringify(missing)).not.toContain(root);
  const invalid = await client.callTool({ name: "read_code", arguments: { path: 123 } });
  expect(invalid.isError).toBe(true);
  expect(outcomes).toEqual([
    { name: "review_context", ok: true, durationMs: expect.any(Number) },
    { name: "set_analysis", ok: true, durationMs: expect.any(Number) },
    { name: "unknown", ok: false, code: "operation_not_granted", durationMs: expect.any(Number) },
    { name: "read_code", ok: false, code: "invalid_operation", durationMs: expect.any(Number) },
    { name: "read_code", ok: false, code: "invalid_operation", durationMs: expect.any(Number) },
  ]);
  expect(JSON.stringify(outcomes)).not.toMatch(/missing|Change foo|publish/);
  expect((await fetch(binding.url, { method: "POST", headers: { Origin: "https://evil.invalid" } })).status).toBe(404);
  expect((await fetch(binding.url.replace(/mcp\/.*/, "mcp/wrong"), { method: "POST" })).status).toBe(404);
  await binding.close();
  await expect(fetch(binding.url, { method: "POST" })).rejects.toThrow();
});

it("creates, edits and trashes drafts through the real server, preserving boundaries", async () => {
  let app: ReturnType<typeof createApp>;
  await new Promise<void>(resolve => { http = serve({ fetch: (...args) => app.fetch(...args), hostname: "127.0.0.1", port: 0 }, () => resolve()); });
  const port = (http!.address() as { port: number }).port;
  app = createApp({ stateDir: root, port, webDist: path.join(root, "no-web"), autoAnalyze: false, reviewRequestRefresh: false, updateChecker: false });
  const ops = createReviewOperations(request("chat", { serverUrl: `http://127.0.0.1:${port}` }), "codex");
  const result = await ops.execute("create_draft", { file: "src/foo.ts", subjectType: "line", line: 2, body: "Check new2", audience: "agent" }) as any;
  const reply = await ops.execute("create_draft", { file: "src/foo.ts", line: 900, side: "LEFT", body: "Reply on an outdated thread", inReplyTo: "thread-1" }) as any;
  expect(reply.comment).toMatchObject({ inReplyTo: "thread-1", line: 900, side: "LEFT", audience: "github", status: "draft" });
  await ops.execute("delete_draft", { id: reply.comment.id });
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../core/dist/cli.js", import.meta.url)),
    "comment", "add", keyToString(key), "--file", "src/foo.ts", "--line", "901", "--side", "LEFT",
    "--in-reply-to", "thread-cli", "--body", "CLI reply"], {
    env: { ...process.env, REVIEWER_STATE_DIR: root, PURVIEW_SERVER_URL: `http://127.0.0.1:${port}`, PURVIEW_ACTOR: "chat", PURVIEW_AGENT: "codex" },
  });
  const cliReply = readComments(key, root).find(c => c.inReplyTo === "thread-cli")!;
  expect(cliReply).toMatchObject({ status: "draft", audience: "github", line: 901, side: "LEFT" });
  await ops.execute("delete_draft", { id: cliReply.id });
  const id = result.comment.id;
  expect(readComments(key, root)).toContainEqual(expect.objectContaining({ id, author: { agent: "codex" }, audience: "agent", status: "draft", line: 2 }));
  await ops.execute("edit_draft", { id, body: "Rechecked new2", audience: "github" });
  expect(readComments(key, root).find(c => c.id === id)).toMatchObject({ body: "Rechecked new2", audience: "github", status: "draft" });
  await expect(ops.execute("edit_draft", { id })).rejects.toThrow();
  const human = addComment(key, { file: "src/foo.ts", subjectType: "line", line: 2, side: "RIGHT", body: "Human note" }, root);
  await ops.execute("edit_draft", { id: human.id, body: "Authorized revision" });
  expect(readComments(key, root).find(c => c.id === human.id)).toMatchObject({
    author: "you", body: "Authorized revision", lastEditedBy: { agent: "codex" },
    history: [expect.objectContaining({ body: "Human note" })],
  });
  await ops.execute("edit_draft", { id: human.id, audience: "agent" });
  expect(readComments(key, root).find(c => c.id === human.id)).toMatchObject({
    author: "you", body: "Authorized revision", audience: "agent", status: "draft",
  });
  await ops.execute("delete_draft", { id: human.id });
  expect(readDeletedComments(key, root).find(c => c.id === human.id)).toMatchObject({
    body: "Authorized revision", deletedBy: { agent: "codex" },
  });
  const published = addComment(key, { file: "src/foo.ts", subjectType: "line", line: 2, side: "RIGHT", body: "Published note" }, root);
  for (const status of ["pushed", "submitted"] as const) {
    writeComments(key, readComments(key, root).map(c => c.id === published.id ? { ...c, status } : c), root);
    await expect(ops.execute("edit_draft", { id: published.id, body: "Forbidden" })).rejects.toMatchObject({ code: "not_draft" });
    await expect(ops.execute("edit_draft", { id: published.id, audience: "agent" })).rejects.toMatchObject({ code: "not_draft" });
    await expect(ops.execute("delete_draft", { id: published.id })).rejects.toMatchObject({ code: "not_draft" });
  }
  await expect(ops.execute("create_draft", { file: "absent.ts", subjectType: "line", line: 2, body: "bad" })).rejects.toMatchObject({ code: "comment_outside_diff" });
  await ops.execute("delete_draft", { id });
  expect(readDeletedComments(key, root).some(c => c.id === id)).toBe(true);
  const hunkId = Object.keys(loadState(key, root).hunks)[0];
  const marked = await ops.execute("mark_viewed", { hunkIds: [hunkId] }) as any;
  expect(marked).toMatchObject({ marked: [hunkId], viewed: true, progress: { viewed: 1 } });
  expect(loadState(key, root).hunks[hunkId]?.viewed).toBe(true);
  await ops.execute("mark_viewed", { hunkIds: [hunkId], viewed: false });
  expect(loadState(key, root).hunks[hunkId]?.viewed).toBe(false);
  await expect(ops.execute("mark_viewed", { unitId: "nope" })).rejects.toMatchObject({ code: "unknown_unit" });
  await expect(ops.execute("mark_viewed", { viewed: true })).rejects.toThrow();
  let bodyController: ReadableStreamDefaultController<Uint8Array>;
  const incoming = new Request(`http://127.0.0.1:${port}/api/prs/${encodeURIComponent(keyToString(key))}/comments`, { method: "POST",
    headers: { "Content-Type": "application/json", "X-Purview-Actor": "chat", "X-Purview-Revision": "1" },
    body: new ReadableStream<Uint8Array>({ start(controller) { bodyController = controller; } }), duplex: "half" } as RequestInit);
  const response = app.fetch(incoming);
  await vi.waitFor(() => expect(incoming.bodyUsed).toBe(true));
  nextRevision(); // Same valid anchor, but the caller observed another revision.
  bodyController!.enqueue(new TextEncoder().encode(JSON.stringify({ file: "src/foo.ts", subjectType: "line", line: 2, side: "RIGHT", body: "stale" })));
  bodyController!.close();
  const late = await response;
  expect(late.status).toBe(409);
  expect(readComments(key, root).map(c => c.body)).toEqual(["Published note"]);
});

it("defaults to Claude Code on the shared tools, lists Legacy beside it, and Codex only by opt-in", () => {
  const previous = process.env.PURVIEW_EXPERIMENTAL_HARNESSES;
  try {
    delete process.env.PURVIEW_EXPERIMENTAL_HARNESSES;
    expect(harnessIds()).toEqual(["claude-shared", "claude-code"]);
    expect(getHarness().manifest).toMatchObject({ id: "claude-shared", name: "Claude Code" });
    expect(getHarness("claude-code").manifest.name).toBe("Claude Code (Legacy)");
    expect(() => getHarness("codex")).toThrow("Unknown agent harness");
    process.env.PURVIEW_EXPERIMENTAL_HARNESSES = "1";
    expect(harnessIds()).toEqual(["claude-shared", "claude-code", "codex"]);
    const shared = reviewSystemPrompt(key, root, { task: "analysis", incremental: true });
    expect(shared).toContain("INCREMENTAL:");
    expect(shared).toContain("patch_units");
    expect(shared).not.toContain("reviewer-state");
  } finally {
    if (previous === undefined) delete process.env.PURVIEW_EXPERIMENTAL_HARNESSES;
    else process.env.PURVIEW_EXPERIMENTAL_HARNESSES = previous;
  }
});

it.skipIf(!process.env.PURVIEW_TEST_CODEX_BIN)("native Codex reads shared HTTP tools and cold-resumes with a fresh binding", async () => {
  const modulePath = "../../../scripts/agent-harness-spike/provider.mjs";
  const { provider } = await import(modulePath);
  const api = await provider();
  const store = path.join(root, "agents/codex/store");
  fs.mkdirSync(store, { recursive: true }); fs.writeFileSync(path.join(store, "auth.json"), "{}");
  vi.stubEnv("PURVIEW_CODEX_BIN", process.env.PURVIEW_TEST_CODEX_BIN!);
  vi.stubEnv("PURVIEW_CODEX_HOME", "");
  // Only the test spawner substitutes a local deterministic provider. The
  // production adapter still constructs and checks its complete real config.
  setCodexSpawner((binary, args, opts) => spawn(binary, args[0] === "--version" ? args : [...args,
    "-c", 'model_provider="fixture"', "-c", `model_providers.fixture={name="Local fixture",base_url=${JSON.stringify(api.url)},wire_api="responses",requires_openai_auth=false}`,
  ], opts));
  try {
    const runOnce = async (session?: import("../src/agent/types.js").AgentSession) => {
      api.plan([{ tool: "review_context", args: {} }, ...(!session ? [{ tool: "set_analysis", args: analysis() }] : []), { text: "native done" }]);
      const events = [];
      for await (const event of codexHarness.run({ ...request(session ? "chat" : "analysis"), model: "gpt-6.1-sol", session: session ?? "new", timeoutMs: 30000 }).events) events.push(event);
      const completed = events.filter(e => e.type === "completed");
      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({ ok: true });
      expect(events).toContainEqual({ type: "output", text: "native done" });
      expect(events).toContainEqual({ type: "operation-result", operation: { name: "review_context", ok: true, durationMs: expect.any(Number) } });
      return completed[0].type === "completed" ? completed[0].session! : undefined!;
    };
    const first = await runOnce();
    expect(loadState(key, root).summary).toBe("Change foo");
    expect((await runOnce(first)).id).toBe(first.id);
    expect(api.requests.length).toBeGreaterThanOrEqual(4);
  } finally { setCodexSpawner(null); vi.unstubAllEnvs(); await api.close(); }
}, 70000);


it("reads cached threads with filters, truncation and independent review pagination", async () => {
  const ops = createReviewOperations(request("chat"), "test");
  expect(await ops.execute("list_threads")).toMatchObject({ error: "no_threads_cache", items: [] });
  const author = { login: "reader", bot: false };
  const thread = { id: "thread-1", path: "src/foo.ts", line: 2, isResolved: false, isOutdated: true,
    comments: [{ author, isMine: true, createdAt: "yesterday", body: "x".repeat(601) }] };
  fs.writeFileSync(path.join(prDir(key, root), "threads.json"), JSON.stringify({ fetchedAt: "today",
    threads: [thread, { ...thread, id: "thread-2", path: "else.ts", isResolved: true, comments: [] }],
    reviews: [1, 2].map(n => ({ author, state: "APPROVED", submittedAt: String(n), body: "fine" })) }));
  const first = await ops.execute("list_threads", { limit: 1 }) as any;
  expect(first).toMatchObject({ fetchedAt: "today", total: 2, reviews: { total: 2 } });
  expect(first.items[0]).toMatchObject({ outdated: true, authorKinds: ["human"], comments: [{ author: "reader", isMine: true, body: "x".repeat(600), truncated: true }] });
  const next = await ops.execute("list_threads", { limit: 1, cursor: first.nextCursor }) as any;
  expect(next.items[0].id).toBe("thread-2");
  const reviewNext = await ops.execute("list_threads", { limit: 1, reviewsCursor: first.reviews.nextCursor }) as any;
  expect(reviewNext.reviews.items[0].submittedAt).toBe("2");
  for (const only of ["mine", "unresolved"]) {
    const result = await ops.execute("list_threads", { only }) as any;
    expect(result.total).toBe(1);
    expect(result.reviews).toBeUndefined();
  }
  expect(await ops.execute("list_threads", { path: "else.ts" })).toMatchObject({ total: 1 });
  await expect(ops.execute("list_threads", { only: "mine", cursor: first.nextCursor })).rejects.toMatchObject({ code: "stale_cursor" });
});

it("reads CI only from meta and reports unavailable run details honestly", async () => {
  const ops = createReviewOperations(request("chat"), "test");
  expect(await ops.execute("ci_status")).toMatchObject({ error: "no_ci_cache", checks: [] });
  writeMeta(key, { ...readMeta(key, root), ci: { state: "failure", checkedAt: "today", headSha: "head",
    checks: [{ name: "Tests", state: "failure", url: "https://example.com/run" }] } }, root);
  expect(await ops.execute("ci_status")).toEqual({ state: "failure", fetchedAt: "today", headSha: "head",
    checks: [{ name: "Tests", state: "failure", url: "https://example.com/run", conclusion: null, startedAt: null, completedAt: null }] });
});

it("blames actual local lines, reuses commit metadata and validates ranges and paths", async () => {
  execFileSync("git", ["-C", checkout, "-c", "user.name=Reviewer", "-c", "user.email=reviewer@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "Initial lines"]);
  const ops = createReviewOperations(request("chat"), "test");
  const result = await ops.execute("blame", { path: "src/foo.ts", start: 1, end: 3 }) as any;
  expect(result.rows).toHaveLength(3);
  expect(result.rows.map((r: any) => r.line)).toEqual([1, 2, 3]);
  for (const row of result.rows) expect(row).toMatchObject({ author: "Reviewer", summary: "Initial lines", date: expect.stringMatching(/^\d{4}-/), sha: result.rows[0].sha });
  for (const range of [{ start: 0, end: 2 }, { start: 3, end: 2 }, { start: 1, end: 402 }]) {
    await expect(ops.execute("blame", { path: "src/foo.ts", ...range })).rejects.toThrow();
  }
  await expect(ops.execute("blame", { path: "../private", start: 1, end: 1 })).rejects.toMatchObject({ code: "outside_checkout" });
  const noCheckout = createReviewOperations(request("chat", { checkout: undefined }), "test");
  await expect(noCheckout.execute("blame", { path: "src/foo.ts", start: 1, end: 1 })).rejects.toMatchObject({ code: "no_checkout" });
  await expect(createReviewOperations(request("analysis"), "test").execute("blame", {})).rejects.toMatchObject({ code: "operation_not_granted" });
});
