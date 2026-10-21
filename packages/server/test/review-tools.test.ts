import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { serve, type ServerType } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadState, keyToString, writeRevision, appendEvent, parseDiff, toRevisionFiles } from "@reviewer/core";
import { createApp } from "../src/app.js";
import { readComments, readDeletedComments, addComment } from "../src/comments.js";
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
  binding = await startReviewTools(request("analysis"), "test");
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
  const id = result.comment.id;
  expect(readComments(key, root)).toContainEqual(expect.objectContaining({ id, author: { agent: "codex" }, audience: "agent", status: "draft", line: 2 }));
  await ops.execute("edit_draft", { id, body: "Rechecked new2" });
  expect(readComments(key, root).find(c => c.id === id)?.body).toBe("Rechecked new2");
  const human = addComment(key, { file: "src/foo.ts", subjectType: "line", line: 2, side: "RIGHT", body: "Human note" }, root);
  await expect(ops.execute("delete_draft", { id: human.id })).rejects.toMatchObject({ code: "consent_required" });
  await expect(ops.execute("create_draft", { file: "absent.ts", subjectType: "line", line: 2, body: "bad" })).rejects.toMatchObject({ code: "comment_outside_diff" });
  await ops.execute("delete_draft", { id });
  expect(readDeletedComments(key, root).some(c => c.id === id)).toBe(true);
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
  expect(readComments(key, root).map(c => c.body)).toEqual(["Human note"]);
});

it("retains native Claude by default and exposes siblings only by opt-in", () => {
  const previous = process.env.PURVIEW_EXPERIMENTAL_HARNESSES;
  try {
    delete process.env.PURVIEW_EXPERIMENTAL_HARNESSES;
    expect(harnessIds()).toEqual(["claude-code"]);
    expect(() => getHarness("codex")).toThrow("Unknown agent harness");
    process.env.PURVIEW_EXPERIMENTAL_HARNESSES = "1";
    expect(harnessIds()).toEqual(["claude-code", "claude-shared", "codex"]);
    expect(getHarness().manifest.id).toBe("claude-code");
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
      return completed[0].type === "completed" ? completed[0].session! : undefined!;
    };
    const first = await runOnce();
    expect(loadState(key, root).summary).toBe("Change foo");
    expect((await runOnce(first)).id).toBe(first.id);
    expect(api.requests.length).toBeGreaterThanOrEqual(4);
  } finally { setCodexSpawner(null); vi.unstubAllEnvs(); await api.close(); }
}, 70000);
