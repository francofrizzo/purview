import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadState } from "@reviewer/core";
import { claudeSharedHarness, setSharedClaudeSpawner } from "../src/agent/claude-shared/index.js";
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
    const script = mode === "hang" ? "setInterval(()=>{},1000)" : `
      console.log(JSON.stringify({type:'system',subtype:'init',session_id:${JSON.stringify(session)}}));
      console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'review answer'}]}}));
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
it("treats a native error result as failure even on exit zero", async () => {
  mode = "error";
  expect(terminal(await collect(claudeSharedHarness.run(request())))).toMatchObject({ ok: false, error: "Claude returned an error result" });
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
    } finally { await api.close(); }
  }, 40000);
});
