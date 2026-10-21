import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createEvalFixture } from "./eval-fixture.mjs";
import { runClaudeEval, runCodexEval } from "./eval-harness.mjs";
import { provider } from "./provider.mjs";

async function setup(t, id) {
  const f = await createEvalFixture(id);
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
