import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createEvalFixture } from "./eval-fixture.mjs";
import { runClaudeEval, runCodexEval } from "./eval-harness.mjs";
import { provider } from "./provider.mjs";
import { loadState, readEvents } from "../../packages/core/dist/index.js";

async function setup(t, id, options) {
  const f = await createEvalFixture(id, options);
  const api = await provider();
  t.after(async () => { await api.close(); f.dispose(); });
  const environment = { HOME: f.root, CLAUDE_CONFIG_DIR: path.join(f.root, "claude"),
    ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "local-fixture-not-a-secret",
    CLAUDE_CODE_OAUTH_TOKEN: "", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ENABLE_TOOL_SEARCH: "false", HTTPS_PROXY: api.url, HTTP_PROXY: api.url, NO_PROXY: "127.0.0.1,localhost" };
  fs.mkdirSync(environment.CLAUDE_CONFIG_DIR);
  return { f, api, environment };
}

const body = "Please confirm the archive seat increase from 2 to 9 is intentional.";
const transcript = api => JSON.stringify(api.requests.map(r => r.body.messages ?? r.body.input));

for (const harness of ["claude", "codex"]) test(`${harness}: shared MCP reaches real state, denies ungranted tools, and returns data to model`, { timeout: 90000 }, async t => {
  const { f, api, environment } = await setup(t, "draft-comment");
  api.plan([{ tool: "review_context", args: {} }, { tool: "read_code", args: { path: "src/pricing.js" } },
    { tool: "create_draft", args: { ...f.anchor, body, audience: "github" } }, { text: "draft-saved" }]);
  const result = harness === "claude"
    ? await runClaudeEval(f, { surface: "shared", environment, timeoutMs: 60000 })
    : await runCodexEval(f, { api, environment, timeoutMs: 60000 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.grade(result.answer).pass, true, JSON.stringify(result));
  assert.deepEqual(result.operations.map(o => [o.name, o.ok]), [["review_context", true], ["read_code", true], ["create_draft", true]]);
  assert.ok(transcript(api).includes("41 + seats * 7"));
  const request = api.requests[0].body;
  const tools = request.tools ?? request.input?.find(i => i.type === "additional_tools")?.tools ?? [];
  const names = tools.flatMap(t => t.type === "namespace" ? t.tools.map(x => x.name) : [t.name]);
  assert.ok(names.length > 0);
  assert.ok(!names.some(n => ["Bash", "shell_command", "exec_command", "Write", "Edit", "set_analysis"].includes(n)));
});

for (const harness of ["claude", "codex"]) test(`${harness}: analysis schema crosses MCP and persists validated coverage and finding`, { timeout: 90000 }, async t => {
  const { f, api, environment } = await setup(t, "initial-analysis");
  const payload = { summary: "Archive billing", units: [{ id: "invoice", title: "Invoice",
    summary: "Seat increase", kind: "core-logic", attention: "must-read", attentionWhy: "Billing change", order: 1,
    hunks: f.hunkIds, findings: [{ severity: "warning", text: "archive increases from 55 to 104", evidence: "src/invoice.js:2, src/pricing.js:2" }] }] };
  // Regression: Codex silently omitted this whole tool when the core line
  // tuple was published using draft-7's array-valued items spelling.
  api.plan([{ tool: "set_analysis", args: payload },
    { text: "analysis-saved" }]);
  const result = harness === "claude"
    ? await runClaudeEval(f, { surface: "shared", environment, timeoutMs: 60000 })
    : await runCodexEval(f, { api, environment, timeoutMs: 60000 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.grade(result.answer).pass, true, JSON.stringify(result));
  assert.ok(transcript(api).includes('remaining'));
});

test("Claude baseline uses the current harness and real reviewer-state CLI with disposable state", { timeout: 60000 }, async t => {
  const { f, api, environment } = await setup(t, "draft-comment");
  // cliCommand's wrapper path and the production Bash policy match exactly.
  const cli = path.join(f.root, "cli", "reviewer-state");
  const command = `'${cli}' comment add github.com/eval/synthetic/19 --file src/invoice.js --line 2 --side RIGHT --for github --body '${body}'`;
  api.plan([{ tool: "Bash", args: { command } }, { text: "draft-saved" }]);
  const result = await runClaudeEval(f, { surface: "baseline", environment, timeoutMs: 45000 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.grade(result.answer).pass, true, transcript(api));
  assert.ok(result.toolNames.includes("Bash"));
});

for (const harness of ["claude", "codex"]) test(`${harness}: cold resume after real migration uses a fresh revision-bound MCP and patches incrementally`, { timeout: 120000 }, async t => {
  const { f, api, environment } = await setup(t, "resumed-incremental", { revision: 1 });
  const invoke = session => harness === "claude"
    ? runClaudeEval(f, { surface: "shared", environment, session, timeoutMs: 45000 })
    : runCodexEval(f, { api, environment, session, timeoutMs: 45000 });
  api.plan([{ tool: "review_context", args: {} }, { tool: "review_units", args: {} }, { tool: "review_diff", args: {} }, { text: "ready" }]);
  const first = await invoke();
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.ok(first.session?.id);
  assert.equal(fs.readdirSync(f.root).filter(n => n.startsWith("run-context-")).length, 0);
  f.advanceRevision();
  const stable = structuredClone(loadState(f.key, f.root).units.find(u => u.id === "stable"));
  const units = [
    { id: "invoice", patch: { summary: "Updated invoice", findings: [{ severity: "warning", text: "archive changes from 55 to 69", evidence: "src/invoice.js:2, src/pricing.js:2" }], changelogEntry: "Changed seats" } },
    { id: "retired", patch: { changelogEntry: "Removed flag change" } },
    { id: "fee", patch: { title: "Fee", summary: "New fee of 11", kind: "core-logic", attention: "must-read", attentionWhy: "New fee", order: 3,
      hunks: [f.files.find(file => file.path === "src/fees.js").hunks[0].id] } },
  ];
  api.plan([{ tool: "review_context", args: {} }, { tool: "review_changes", args: {} },
    { tool: "patch_units", args: { units } }, { tool: "set_revision_summary", args: { text: "Updated invoice, new fee and retired flag" } }, { text: "updated" }]);
  const second = await invoke(first.session);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.session.id, first.session.id);
  assert.equal(f.grade("").pass, true, JSON.stringify(f.grade("")));
  assert.deepEqual(loadState(f.key, f.root).units.find(u => u.id === "stable"), stable);
  assert.ok(second.operations.some(o => o.name === "patch_units" && o.ok));
  const requests = api.requests.length;
  const events = readEvents(f.key, f.root).length;
  f.task = "chat";
  if (harness === "claude") assert.equal((await invoke(second.session)).ok, false);
  else await assert.rejects(invoke(second.session), /Incompatible session/);
  assert.equal(api.requests.length, requests, "incompatible instructions must not start a model");
  assert.equal(readEvents(f.key, f.root).length, events);
});

test("Claude baseline does not force-resume initial analysis under different incremental instructions", { timeout: 60000 }, async t => {
  const { f, api, environment } = await setup(t, "incremental-analysis", { revision: 1 });
  api.plan([{ text: "ready" }]);
  const first = await runClaudeEval(f, { surface: "baseline", environment, timeoutMs: 45000 });
  assert.equal(first.ok, true);
  f.advanceRevision();
  const requests = api.requests.length;
  const next = await runClaudeEval(f, { surface: "baseline", environment, session: first.session });
  assert.equal(next.ok, false);
  assert.equal(api.requests.length, requests);
});
