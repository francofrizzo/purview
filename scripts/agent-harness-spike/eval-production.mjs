// Evaluates the shipped-code-path adapters and prompts, not the prototype MCP.
// Only this runner depends on the spike fixtures; production imports none of it.
import path from "node:path";
import { createHash } from "node:crypto";
import { serve } from "../../packages/server/node_modules/@hono/node-server/dist/index.mjs";
import { createApp } from "../../packages/server/dist/app.js";
import { claudeSharedHarness } from "../../packages/server/dist/agent/claude-shared/index.js";
import { codexHarness } from "../../packages/server/dist/agent/codex/index.js";
import { reviewSystemPrompt, reviewRunPrompt } from "../../packages/server/dist/agent/review-tools/prompts.js";

export async function runClaudeEval(fixture, opts) {
  if (opts.surface === "baseline") {
    const { runClaudeEval } = await import("./eval-harness.mjs");
    return runClaudeEval(fixture, opts);
  }
  return run(fixture, claudeSharedHarness, opts);
}
export const runCodexEval = (fixture, opts) => run(fixture, codexHarness, opts);

async function run(f, harness, { model, effort, timeoutMs, signal }) {
  let app;
  let http;
  let active;
  let completed = false;
  const cancel = () => active?.cancel();
  const started = Date.now();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    await new Promise(resolve => { http = serve({ fetch: (...args) => app.fetch(...args), hostname: "127.0.0.1", port: 0 }, resolve); });
    const port = http.address().port;
    app = createApp({ stateDir: f.root, port, autoAnalyze: false, reviewRequestRefresh: false,
      updateChecker: false, webDist: path.join(f.root, "no-web") });
    const instructions = reviewSystemPrompt(f.key, f.root, { task: f.task, incremental: f.incremental });
    const prompt = f.task === "analysis"
      ? `${reviewRunPrompt(f.key, f.root, { path: f.checkout }, f.incremental)}\n\nEVALUATION TASK:\n${f.prompt}` : f.prompt;
    active = harness.run({ task: f.task === "analysis" ? { kind: "analysis", scratchDir: f.root, reviewerCommands: [] }
      : { kind: "chat", reviewerCommands: [] },
      review: { root: f.root, key: f.key, revision: f.revision, checkout: f.checkout,
        analysisMode: f.incremental ? "incremental" : "initial", serverUrl: `http://127.0.0.1:${port}` },
      cwd: f.checkout, model, effort, instructions, prompt, timeoutMs, session: "new" });
    if (signal?.aborted) active.cancel();
    const result = { ok: false, modelRequested: model, effort, usage: {}, operations: [], toolNames: [],
      // These aren't observable in normalized events: unknown, not zero.
      permissionDenials: null, toolErrors: null, instructionsHash: createHash("sha256").update(instructions).digest("hex") };
    let answer = "";
    for await (const event of active.events) {
      if (event.type === "output") answer = event.text;
      if (event.type === "usage") result.usage = event.usage;
      if (event.type === "session") {
        result.session = event.session; result.modelResolved = event.resolvedModel; result.harnessVersion = event.harnessVersion;
      }
      if (event.type === "action") {
        result.toolNames.push(event.action.name);
        result.operations.push({ name: event.action.name, attempted: true });
      }
      if (event.type === "completed") { completed = true; result.ok = event.ok; if (!event.ok) result.failure = "harness_failed_or_timed_out"; }
    }
    return { ...result, answer: result.ok ? answer : "", wallMs: Date.now() - started };
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (!completed) active?.cancel();
    if (http) await new Promise(resolve => { http.close(resolve); http.closeAllConnections(); });
  }
}
