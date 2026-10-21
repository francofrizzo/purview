import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadState } from "@reviewer/core";
import { acceptedClaudeVersion, claudeSharedHarness, setSharedClaudeSpawner, unexpectedCapability } from "../src/agent/claude-shared/index.js";
import { buildFixture, key } from "./fixtures.js";
import type { AgentEvent, AgentRun, AgentRunRequest } from "../src/agent/types.js";

let root: string;
let mode: string;
const request = (extra: Partial<AgentRunRequest> = {}): AgentRunRequest => ({ task: { kind: "chat", reviewerCommands: [] },
  review: { root, key, revision: 1 }, cwd: root, prompt: "review", instructions: "Bound review", model: "sonnet", session: "new", ...extra });
async function collect(run: AgentRun) { const events: AgentEvent[] = []; for await (const event of run.events) events.push(event); return events; }
const terminal = (events: AgentEvent[]) => { const end = events.filter(e => e.type === "completed"); expect(end).toHaveLength(1); return end[0]; };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-claude-shared-"));
  buildFixture(root);
  mode = "ok";
  const binary = path.join(root, "claude-version");
  fs.writeFileSync(binary, "#!/bin/sh\nprintf '2.1.305 (Claude Code)\\n'\n", { mode: 0o700 });
  vi.stubEnv("PURVIEW_CLAUDE_BIN", binary);
  setSharedClaudeSpawner((_command, args, opts) => {
    const session = args[args.indexOf(args.includes("--resume") ? "--resume" : "--session-id") + 1];
    const at = args.indexOf("--allowedTools");
    const allowed = at < 0 ? [] : args.slice(at + 1).filter(a => a.startsWith("mcp__purview__"));
    const tools = mode === "extra-tool" ? [...allowed, "Bash"] : mode === "missing-tools" ? allowed.slice(1) : mode === "no-tool-list" ? undefined : allowed;
    const servers = mode === "no-mcp" ? [] : [{ name: "purview", status: "connected" }];
    const init = JSON.stringify({ type: "system", subtype: "init", session_id: session, tools, mcp_servers: servers, claude_code_version: "2.1.305" });
    const script = mode === "hang" ? "setInterval(()=>{},1000)" : `
      ${mode === "late-init" ? "console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'unverified answer'}]}}));" : ""}
      ${["no-init", "result-only"].includes(mode) ? "" : `console.log(${JSON.stringify(init)});`}
      ${mode === "result-only" ? "" : "console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'review answer'}]}}));"}
      console.log(JSON.stringify({type:'result',is_error:${mode === "error"},usage:{input_tokens:17,output_tokens:3}}));`;
    return spawn(process.execPath, ["-e", script], { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
  });
});
afterEach(() => { setSharedClaudeSpawner(null); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

it("normalizes text/usage and resumes only sessions with unchanged instructions", async () => {
  const events = await collect(claudeSharedHarness.run(request()));
  const end = terminal(events);
  expect(end).toMatchObject({ ok: true });
  expect(events).toContainEqual({ type: "output", text: "review answer" });
  expect(events).toContainEqual(expect.objectContaining({ type: "usage", usage: expect.objectContaining({ inputTokens: 17, outputTokens: 3 }) }));
  const session = end.type === "completed" ? end.session! : undefined!;
  expect(claudeSharedHarness.canResume(session, { cwd: root, instructions: "Bound review" })).toBe(true);
  expect(claudeSharedHarness.canResume(session, { cwd: root, instructions: "Different rules" })).toBe(false);
  const resumed = terminal(await collect(claudeSharedHarness.run(request({ session }))));
  expect(resumed).toMatchObject({ ok: true, session: { id: session.id } });
});
it("accepts the minimum CLI version and newer, nothing older or unparseable", () => {
  expect(acceptedClaudeVersion("2.1.305 (Claude Code)\n")).toBe("2.1.305");
  expect(acceptedClaudeVersion("2.1.306 (Claude Code)")).toBe("2.1.306");
  expect(acceptedClaudeVersion("2.2.0 (Claude Code)")).toBe("2.2.0");
  expect(acceptedClaudeVersion("3.0.0 (Claude Code)")).toBe("3.0.0");
  expect(acceptedClaudeVersion("2.1.304 (Claude Code)")).toBeUndefined();
  expect(acceptedClaudeVersion("2.0.999 (Claude Code)")).toBeUndefined();
  expect(acceptedClaudeVersion("2.1.306")).toBeUndefined();
  expect(acceptedClaudeVersion("not a version")).toBeUndefined();
  const probe = claudeSharedHarness.probe(() => ({ ok: true, stdout: "2.1.306 (Claude Code)\n", stderr: "" }));
  expect(probe).toMatchObject({ available: true, version: "2.1.306" });
  expect(claudeSharedHarness.probe(() => ({ ok: true, stdout: "2.1.300 (Claude Code)\n", stderr: "" })).available).toBe(false);
});
it("runs on a newer CLI and refuses an older one by version", async () => {
  const binary = process.env.PURVIEW_CLAUDE_BIN!;
  fs.writeFileSync(binary, "#!/bin/sh\nprintf '2.1.306 (Claude Code)\\n'\n", { mode: 0o700 });
  expect(terminal(await collect(claudeSharedHarness.run(request())))).toMatchObject({ ok: true });
  fs.writeFileSync(binary, "#!/bin/sh\nprintf '2.1.304 (Claude Code)\\n'\n", { mode: 0o700 });
  expect(terminal(await collect(claudeSharedHarness.run(request())))).toMatchObject({ ok: false, error: expect.stringMatching(/^Requires Claude Code 2\.1\.305 or newer/) });
});
it("checks capabilities on the init event: only review tools, with the MCP connected", async () => {
  expect(unexpectedCapability({ tools: ["mcp__purview__read_code"], mcp_servers: [{ name: "purview", status: "connected" }] }, ["mcp__purview__read_code"])).toBeUndefined();
  expect(unexpectedCapability({ tools: ["mcp__purview__read_code", "Bash"], mcp_servers: [] }, ["mcp__purview__read_code"])).toMatch(/Unexpected native tool.*Bash/);
  expect(unexpectedCapability({ tools: ["mcp__purview__read_code"], mcp_servers: [{ name: "purview", status: "failed" }] }, ["mcp__purview__read_code"])).toMatch(/review tools connected/);
  expect(unexpectedCapability({ tools: [] }, [])).toBeUndefined();
  expect(unexpectedCapability({}, [])).toMatch(/without a tool list/);
  mode = "extra-tool";
  expect(terminal(await collect(claudeSharedHarness.run(request())))).toMatchObject({ ok: false, error: expect.stringMatching(/^Unexpected native tool/) });
  mode = "no-mcp";
  expect(terminal(await collect(claudeSharedHarness.run(request())))).toMatchObject({ ok: false, error: expect.stringMatching(/^Unexpected Claude session/) });
});
it("treats a native error result as failure even on exit zero", async () => {
  mode = "error";
  expect(terminal(await collect(claudeSharedHarness.run(request())))).toMatchObject({ ok: false, error: "Claude returned an error result" });
});
it.each(["no-init", "result-only", "late-init", "no-tool-list", "missing-tools", "extra-tool", "no-mcp"])("rejects %s without delivering an unverified answer", async failure => {
  mode = failure;
  const events = await collect(claudeSharedHarness.run(request()));
  expect(terminal(events)).toMatchObject({ ok: false, error: expect.stringMatching(/^Unexpected /) });
  expect(events.filter(e => e.type === "output" || e.type === "output-delta")).toEqual([]);
});
it("accepts an explicitly empty capability list for a tool-free reanchor", async () => {
  expect(terminal(await collect(claudeSharedHarness.run(request({ task: { kind: "reanchor" }, review: undefined }))))).toMatchObject({ ok: true });
});
it("ends cancellation and timeout exactly once", async () => {
  mode = "hang";
  const run = claudeSharedHarness.run(request());
  setTimeout(() => run.cancel(), 50);
  expect(terminal(await collect(run))).toMatchObject({ ok: false, error: "cancelled" });
  expect(terminal(await collect(claudeSharedHarness.run(request({ timeoutMs: 30 }))))).toMatchObject({ ok: false, error: "Claude timed out" });
});

// Optional native test, no inference or real credentials: the deterministic
// Messages server forces operations through the actual CLI and HTTP MCP stack.
describe.skipIf(!process.env.PURVIEW_TEST_CLAUDE_BIN)("pinned native Claude with local model transport", () => {
  it("saves analysis through shared MCP without advertising native tools", async () => {
    const modulePath = "../../../scripts/agent-harness-spike/provider.mjs";
    const { provider } = await import(modulePath);
    const api = await provider();
    try {
      vi.stubEnv("PURVIEW_CLAUDE_BIN", process.env.PURVIEW_TEST_CLAUDE_BIN!);
      vi.stubEnv("HOME", root); vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(root, "config"));
      vi.stubEnv("ANTHROPIC_API_KEY", "local-test-only"); vi.stubEnv("ANTHROPIC_AUTH_TOKEN", ""); vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
      vi.stubEnv("ANTHROPIC_BASE_URL", api.url);
      vi.stubEnv("HTTPS_PROXY", api.url); vi.stubEnv("HTTP_PROXY", api.url); vi.stubEnv("NO_PROXY", "127.0.0.1,localhost");
      const { hunkIds } = buildFixture(root);
      api.plan([{ tool: "review_context", args: {} }, { tool: "set_analysis", args: {
        summary: "Native shared analysis", units: [{ id: "foo", title: "Change foo", summary: "Values change", kind: "core-logic",
          attention: "must-read", attentionWhy: "Behavior changes", order: 0, hunks: hunkIds }], unassigned: [],
      } }, { text: "done" }]);
      setSharedClaudeSpawner(null);
      const events = await collect(claudeSharedHarness.run(request({ task: { kind: "analysis", scratchDir: root, reviewerCommands: [] },
        review: { root, key, revision: 1, analysisMode: "initial" }, timeoutMs: 30000 })));
      expect(terminal(events)).toMatchObject({ ok: true });
      expect(loadState(key, root).summary).toBe("Native shared analysis");
      const names = api.requests.flatMap((r: any) => (r.body.tools ?? []).map((t: any) => t.name));
      expect(names).toContain("mcp__purview__set_analysis");
      expect(names.some((name: string) => ["Bash", "Read", "Write", "Edit", "Agent"].includes(name))).toBe(false);
      const first = terminal(events);
      const session = first.type === "completed" ? first.session! : undefined!;
      api.plan([{ tool: "review_context", args: {} }, { text: "resumed done" }]);
      const resumed = await collect(claudeSharedHarness.run(request({ session, timeoutMs: 30000 })));
      expect(terminal(resumed)).toMatchObject({ ok: true, session: { id: session.id } });
      expect(resumed).toContainEqual(expect.objectContaining({ type: "action", action: expect.objectContaining({ name: "review_context" }) }));
      expect(resumed).toContainEqual({ type: "output", text: "resumed done" });
      api.plan([{ text: "tool-free answer" }]);
      const reanchor = await collect(claudeSharedHarness.run(request({ task: { kind: "reanchor" }, review: undefined, timeoutMs: 30000 })));
      expect(terminal(reanchor)).toMatchObject({ ok: true });
      expect(reanchor).toContainEqual({ type: "output", text: "tool-free answer" });
    } finally { await api.close(); }
  }, 40000);
});
