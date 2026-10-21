import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentEvent, AgentRunRequest, AgentSession } from "../src/agent/types.js";

const tools = vi.hoisted(() => ({ closed: 0, started: 0 }));
vi.mock("../src/agent/review-tools/run.js", () => ({ startReviewTools: async (_request: unknown, _id: string, onAction: Function) => {
  tools.started++;
  onAction({ kind: "read", name: "read_review", target: "review", summary: "review" });
  return { url: `http://127.0.0.1:12345/capability-${tools.started}`, names: ["read_review"], close: async () => { tools.closed++; } };
} }));
import { codexHarness, setCodexSpawner } from "../src/agent/codex/index.js";

let root: string;
let mode: string;
let children: ChildProcessWithoutNullStreams[];
let configurations: any[];
let launchDirectories: string[];
const request = (extra: Partial<AgentRunRequest> = {}): AgentRunRequest => ({ task: { kind: "chat", reviewerCommands: ["show"] },
  review: { root, key: { host: "github.com", owner: "test", repo: "test", number: 1 }, revision: 1 },
  cwd: "/not-the-launch-directory", prompt: "test input", instructions: "Review carefully", model: "gpt-6.1-sol", timeoutMs: 2000, ...extra });
async function collect(run: ReturnType<typeof codexHarness.run>) {
  const events: AgentEvent[] = [];
  for await (const event of run.events) {
    if (event.type === "completed" && tools.started) expect(tools.closed).toBe(tools.started);
    events.push(event);
  }
  expect(events.filter(e => e.type === "completed")).toHaveLength(1);
  return events;
}
function terminal(events: AgentEvent[]) { return events.find(e => e.type === "completed")!; }

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "purview-codex-test-"));
  const store = path.join(root, "agents", "codex", "store");
  mkdirSync(store, { recursive: true }); writeFileSync(path.join(store, "auth.json"), "{}");
  vi.stubEnv("PURVIEW_CODEX_BIN", process.execPath); vi.stubEnv("PURVIEW_CODEX_HOME", "");
  tools.closed = 0; tools.started = 0; mode = "ok"; children = []; configurations = []; launchDirectories = [];
  setCodexSpawner((_command, args, options) => {
    expect(options.env.HOME).toBe(path.join(root, "agents", "codex", "home"));
    expect(options.env.CODEX_HOME).toBe(store);
    expect(options.env).not.toHaveProperty("OPENAI_API_KEY");
    let script: string;
    if (args[0] === "--version") script = mode === "startup-hang" ? "setInterval(()=>{},1000)" : `console.log('codex-cli ${mode === "version" ? "0.162.0" : mode === "newer" ? "0.164.0" : "0.163.0"}')`;
    else {
      const config: any = {};
      for (let i = 3; i < args.length; i += 2) { const entry = args[i + 1]; const split = entry.indexOf("="); config[entry.slice(0, split)] = JSON.parse(entry.slice(split + 1).replace(/=/g, ":")); }
      configurations.push(config); launchDirectories.push(options.cwd);
      script = `
        const config=${JSON.stringify(config)}, mode=${JSON.stringify(mode)};
        const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
        const event=(method,params)=>send({method,params});
        require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
          const m=JSON.parse(line); if(!m.id)return;
          if(mode==='rpc-hang')return;
          if(mode==='rpc-error'){send({id:m.id,error:{message:'SECRET_AUTH_ERROR'}});return;}
          if(mode==='request'){send({id:999,method:'future/permission',params:{}});return;}
          let result={};
          if(m.method==='config/read') {
            // Match 0.163.0's typed projection, not just echo argv.
            delete config.tools.update_plan;
            delete config.tools.experimental_request_user_input;
            config.permissions.purview.filesystem.glob_scan_max_depth=null;
            config.permissions.purview.extends=null;
            config.permissions.purview.workspace_roots=null;
            if(mode==='unsafe')config.mcp_servers.foreign={url:'http://evil'};
            if(mode==='extra-tool')config.mcp_servers.purview.enabled_tools.push('unexpected');
            if(mode==='extra-root')config.permissions.purview.filesystem['/unowned']='write';
            if(mode==='shell')config.features.shell_tool=true;
            result={config};
          }
          if(m.method==='thread/start'||m.method==='thread/resume') {
            if(!m.params.baseInstructions.includes('[Purview Codex adaptation]'))process.exit(9);
            result={thread:{id:m.params.threadId||'stable-thread',model:config.model}};
          }
          if(m.method==='turn/start')result={turn:{id:'turn'}};
          send({id:m.id,result});
          if(m.method==='turn/start') {
            event('item/agentMessage/delta',{delta:'answer'});
            event('item/completed',{item:{type:'agentMessage',text:'answer'}});
            event('thread/tokenUsage/updated',{tokenUsage:{total:{inputTokens:12,outputTokens:3,cachedInputTokens:2}}});
            event('turn/completed',{turn:{id:'turn',status:'completed'}});
          }
        });`;
    }
    const child = spawn(process.execPath, ["-e", script], options); children.push(child); return child;
  });
});
afterEach(() => { setCodexSpawner(null); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe("experimental Codex harness", () => {
  it("probes the minimum version and newer through the supplied Exec", () => {
    for (const version of ["0.162.0", "0.163.0", "0.164.0", "1.0.0"]) {
      const exec = vi.fn(() => ({ ok: true, stdout: `codex-cli ${version}\n`, stderr: "private" }));
      expect(codexHarness.probe(exec).available).toBe(version !== "0.162.0");
      expect(exec).toHaveBeenCalledWith(process.execPath, ["--version"]);
    }
  });
  it("normalizes output, usage and actions and revokes before completion", async () => {
    const events = await collect(codexHarness.run(request({ session: "new" })));
    expect(terminal(events)).toMatchObject({ ok: true });
    expect(events).toContainEqual({ type: "output-delta", text: "answer" });
    expect(events).toContainEqual({ type: "output", text: "answer" });
    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 12, outputTokens: 3, cacheReadInputTokens: 2 } });
    expect(events.some(e => e.type === "action")).toBe(true);
    expect(configurations[0].mcp_servers.purview).toMatchObject({ required: true, enabled_tools: ["read_review"], default_tools_approval_mode: "approve" });
    expect(launchDirectories[0]).not.toBe(request().cwd);
    expect(existsSync(launchDirectories[0])).toBe(false);
    for (const child of children) expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
  it("cold resumes the same thread with fresh owned binding and validates session identity", async () => {
    const first = await collect(codexHarness.run(request({ session: "new" })));
    const session = (first.find(e => e.type === "session") as { session: AgentSession }).session;
    expect(codexHarness.canResume(session, request())).toBe(true);
    for (const changed of [{ ...session, harness: "other" }, { ...session, cwd: "/other" }, { ...session, fingerprint: "old" }]) expect(codexHarness.canResume(changed, request())).toBe(false);
    expect(codexHarness.canResume(session, { ...request(), instructions: "different" })).toBe(false);
    const second = await collect(codexHarness.run(request({ session })));
    expect(terminal(second)).toMatchObject({ ok: true, session: { id: session.id, cwd: request().cwd } });
    expect(configurations[0].mcp_servers.purview.url).not.toBe(configurations[1].mcp_servers.purview.url);
  });
  it("keeps reanchor tool-free", async () => {
    const events = await collect(codexHarness.run(request({ task: { kind: "reanchor" } })));
    expect(terminal(events)).toMatchObject({ ok: true }); expect(tools.started).toBe(0);
    expect(configurations[0].mcp_servers).toEqual({});
    expect(events.some(e => e.type === "output-delta")).toBe(false);
  });
  it.each(["version", "unsafe", "extra-tool", "extra-root", "shell", "request", "rpc-error"])("fails closed for %s without leaking diagnostics", async value => {
    mode = value;
    const events = await collect(codexHarness.run(request()));
    expect(terminal(events)).toMatchObject({ ok: false }); expect(JSON.stringify(events)).not.toContain("SECRET_AUTH_ERROR");
  });
  it.each(["startup-hang", "rpc-hang"])("cancels and terminates the owned process during %s", async value => {
    mode = value; const run = codexHarness.run(request());
    setTimeout(() => run.cancel(), 100);
    expect(terminal(await collect(run))).toMatchObject({ ok: false, error: "cancelled" });
    for (const child of children) expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
  it("times out outstanding RPC and revokes capabilities", async () => {
    mode = "rpc-hang";
    expect(terminal(await collect(codexHarness.run(request({ timeoutMs: 100 }))))).toMatchObject({ ok: false, error: "Codex timed out" });
  });
  it("requires independent login and refuses ambient private config", async () => {
    const store = path.join(root, "agents", "codex", "store");
    rmSync(path.join(store, "auth.json"));
    expect(terminal(await collect(codexHarness.run(request())))).toMatchObject({ ok: false, error: expect.stringContaining("Manually log in") });
    writeFileSync(path.join(store, "config.toml"), 'model_provider="foreign"');
    expect(terminal(await collect(codexHarness.run(request())))).toMatchObject({ ok: false, error: expect.stringContaining("Unsafe ambient") });
    expect(children).toHaveLength(0);
  });
  it("refuses project config above its private cwd before starting Codex", async () => {
    mkdirSync(path.join(root, ".codex")); writeFileSync(path.join(root, ".codex", "config.toml"), "");
    expect(terminal(await collect(codexHarness.run(request())))).toMatchObject({ ok: false, error: expect.stringContaining("Unsafe ambient project") });
    expect(children).toHaveLength(0);
  });
  it("reports spawn failure once and still revokes tools", async () => {
    setCodexSpawner(() => { throw new Error("SECRET_AUTH_ERROR"); });
    const events = await collect(codexHarness.run(request()));
    expect(terminal(events)).toMatchObject({ ok: false });
    expect(JSON.stringify(events)).not.toContain("SECRET_AUTH_ERROR");
  });
});
