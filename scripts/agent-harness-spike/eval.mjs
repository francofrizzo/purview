import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { EVAL_CASES, createEvalFixture } from "./eval-fixture.mjs";
import { loadState, readEvents } from "../../packages/core/dist/index.js";
import { readComments } from "../../packages/server/dist/comments.js";

export const ARMS = ["claude-baseline", "claude-shared", "codex-shared"];

export function parseOptions(argv) {
  const options = { run: false, arms: ARMS.slice(0, 2), cases: EVAL_CASES.filter(c => !c.optional).map(c => c.id), repeats: 3,
    claudeModel: "sonnet", codexModel: "gpt-6.1-sol", effort: "medium", timeoutMs: 180000, runtime: "spike" };
  const fields = { "--arms": "arms", "--cases": "cases", "--repeats": "repeats", "--claude-model": "claudeModel",
    "--codex-model": "codexModel", "--effort": "effort", "--timeout-ms": "timeoutMs", "--out": "out", "--runtime": "runtime" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--run") { options.run = true; continue; }
    if (["--list", "--help"].includes(flag)) continue;
    const field = fields[flag];
    if (!field || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("Invalid options; see eval.md");
    const value = argv[++i];
    options[field] = ["arms", "cases"].includes(field) ? value.split(",")
      : ["repeats", "timeoutMs"].includes(field) ? Number(value) : value;
  }
  for (const [items, allowed] of [[options.arms, ARMS], [options.cases, EVAL_CASES.map(c => c.id)]]) {
    if (!items.length || new Set(items).size !== items.length || items.some(x => !allowed.includes(x))) throw new Error("Unknown or duplicate arm/case");
  }
  if (!Number.isInteger(options.repeats) || options.repeats < 1 || options.repeats > 20) throw new Error("repeats must be 1..20");
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 1800000) throw new Error("timeout-ms must be 1000..1800000");
  if (!["low", "medium", "high"].includes(options.effort)) throw new Error("effort must be low, medium or high");
  if (!["spike", "production"].includes(options.runtime)) throw new Error("runtime must be spike or production");
  if (options.runtime === "production" && options.cases.includes("resumed-incremental")) {
    throw new Error("Production runner does not yet audit successful warmup operations; native cold resume has a separate integration test");
  }
  if (options.cases.includes("resumed-incremental") && options.arms.includes("claude-baseline")) {
    throw new Error("resumed-incremental supports shared arms only; baseline changes system instructions across modes");
  }
  for (const model of [options.claudeModel, options.codexModel]) if (!/^[a-zA-Z0-9_.:-]+$/.test(model)) throw new Error("Invalid model ID");
  if (options.run && !options.out) throw new Error("--run requires --out to a NEW JSONL file; this consumes model quota");
  return options;
}

export function runPlan(options) {
  const runs = [];
  for (let repeat = 1; repeat <= options.repeats; repeat++) for (const [index, caseId] of options.cases.entries()) {
    // Counterbalance paired Claude order; don't reuse state or run concurrently.
    const arms = (repeat + index) % 2 ? options.arms : [...options.arms].reverse();
    for (const arm of arms) runs.push({ repeat, caseId, arm });
  }
  return runs;
}

function metadata() {
  const repo = path.resolve(import.meta.dirname, "../..");
  const git = args => execFileSync("git", args, { cwd: repo, encoding: "utf8", timeout: 10000 }).trim();
  return { revision: git(["rev-parse", "HEAD"]), dirty: Boolean(git(["status", "--porcelain"])),
    platform: process.platform, arch: process.arch, node: process.version,
    declaredPins: { claudeSdk: "0.3.305", claudeCli: "2.1.305", codexCli: "0.163.0" } };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  const plan = runPlan(options);
  if (!options.run) {
    console.log(JSON.stringify({ dryRun: true, requests: plan.reduce((n, r) => n + (r.caseId === "resumed-incremental" ? 2 : 1), 0), options, cases: EVAL_CASES, plan,
      next: "No harness/model started. See eval.md; --run --out <new.jsonl> explicitly enables paid runs." }, null, 2));
    return 0;
  }
  // Loaded only after explicit opt-in. Never creates or imports a login.
  const { runClaudeEval, runCodexEval } = await import(options.runtime === "production" ? "./eval-production.mjs" : "./eval-harness.mjs");
  const output = path.resolve(options.out);
  const fd = fs.openSync(output, "wx", 0o600);
  const write = value => { fs.writeSync(fd, JSON.stringify(value) + "\n"); fs.fsyncSync(fd); };
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const results = [];
  try {
    write({ type: "manifest", schema: 1, createdAt: new Date().toISOString(), ...metadata(), options, plannedRuns: plan.length,
      limitations: ["Synthetic functional evaluation, not general review quality or a causal tool-only experiment.",
        "Different prompts and harness context; Claude paired runs hold requested model and effort fixed.",
        "Incremental/resume are optional synthetic cases; no human consent UX or production concurrency validation.",
        "Codex and Claude token/cost accounting is not directly comparable. Missing cost is unknown, never zero."] });
    for (const entry of plan) {
      if (controller.signal.aborted) break;
      let f;
      let result;
      let warmup;
      let phase = "run";
      const started = Date.now();
      try {
        const resumed = entry.caseId === "resumed-incremental";
        f = await createEvalFixture(entry.caseId, { revision: resumed ? 1 : 2 });
        const common = { effort: options.effort, timeoutMs: options.timeoutMs, signal: controller.signal };
        const invoke = (fixture, session) => entry.arm === "codex-shared" ? runCodexEval(fixture, { ...common, session, model: options.codexModel })
          : runClaudeEval(fixture, { ...common, session, model: options.claudeModel, surface: entry.arm === "claude-baseline" ? "baseline" : "shared" });
        let resumedSession;
        if (resumed) {
          phase = "warmup";
          const before = readEvents(f.key, f.root).length;
          warmup = await invoke({ ...f, prompt: "Read review_context, review_units and the invoice diff at revision 1. Do not mutate anything. Report the current invoice finding and say ready." });
          resumedSession = warmup.session;
          const readContext = ["review_context", "review_units", "review_diff"].every(name => warmup.operations.some(o => o.name === name && o.ok));
          if (!warmup.ok || !resumedSession || !readContext || readEvents(f.key, f.root).length !== before) throw new Error("Warmup failed or mutated state");
          f.advanceRevision();
        }
        phase = resumed ? "resume" : "run";
        result = await invoke(f, resumedSession);
        if (resumed) {
          result.resumedSameSession = result.session?.id === resumedSession.id;
          result.ok &&= result.resumedSameSession;
          result.wallMs += warmup.wallMs;
        }
        delete result.session;
        const grading = f.grade(result.answer);
        // Keep synthetic answers for human adjudication, not raw transport/account errors.
        result.answer = result.ok ? result.answer.replaceAll(f.root, "<eval>").replaceAll(os.homedir(), "<home>") : "";
        const state = loadState(f.key, f.root);
        result = { ...result, grading, pass: result.ok && grading.pass,
          promptHash: createHash("sha256").update(f.prompt).digest("hex"), limitations: f.limitations,
          observed: { summary: state.summary, units: state.units, comments: readComments(f.key, f.root) } };
      } catch {
        // Don't echo RPC/backend errors: they can contain account or request data.
        result = { ok: false, pass: false, failure: controller.signal.aborted ? "cancelled" : "setup_transport_or_timeout",
          phase, wallMs: Date.now() - started };
      } finally { f?.dispose(); }
      if (warmup) result.warmup = { ok: warmup.ok, wallMs: warmup.wallMs, usage: warmup.usage,
        operations: warmup.operations, modelResolved: warmup.modelResolved };
      const record = { type: "run", ...entry, ...result };
      write(record);
      results.push(record);
      console.log(`${entry.caseId} ${entry.arm} #${entry.repeat}: ${record.pass ? "PASS" : "FAIL"} (${record.wallMs}ms)`);
    }
    const summary = { type: "summary", planned: plan.length, completed: results.length, cancelled: controller.signal.aborted,
      arms: Object.fromEntries(options.arms.map(arm => {
        const rows = results.filter(r => r.arm === arm);
        return [arm, { completed: rows.length, passed: rows.filter(r => r.pass).length,
          failed: rows.filter(r => !r.pass).length, wallMs: rows.reduce((n, r) => n + r.wallMs, 0) }];
      })) };
    write(summary);
    console.log(JSON.stringify(summary));
    return controller.signal.aborted ? 130 : results.some(r => !r.pass) ? 1 : 0;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    fs.closeSync(fd);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = await main(); }
  catch { console.error("Evaluation not started or report could not be written. Check options, builds and the NEW output path; see eval.md."); process.exitCode = 1; }
}
