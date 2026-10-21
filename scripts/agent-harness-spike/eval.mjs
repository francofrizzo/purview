import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { EVAL_CASES, createEvalFixture } from "./eval-fixture.mjs";
import { loadState } from "../../packages/core/dist/index.js";
import { readComments } from "../../packages/server/dist/comments.js";

export const ARMS = ["claude-baseline", "claude-shared", "codex-shared"];

export function parseOptions(argv) {
  const options = { run: false, arms: ARMS.slice(0, 2), cases: EVAL_CASES.map(c => c.id), repeats: 3,
    claudeModel: "sonnet", codexModel: "gpt-6.1-sol", effort: "medium", timeoutMs: 180000 };
  const fields = { "--arms": "arms", "--cases": "cases", "--repeats": "repeats", "--claude-model": "claudeModel",
    "--codex-model": "codexModel", "--effort": "effort", "--timeout-ms": "timeoutMs", "--out": "out" };
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
    console.log(JSON.stringify({ dryRun: true, requests: plan.length, options, cases: EVAL_CASES, plan,
      next: "No harness/model started. See eval.md; --run --out <new.jsonl> explicitly enables paid runs." }, null, 2));
    return 0;
  }
  // Loaded only after explicit opt-in. Never creates or imports a login.
  const { runClaudeEval, runCodexEval } = await import("./eval-harness.mjs");
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
        "No incremental refresh, resume, human consent UX or production concurrency validation.",
        "Codex and Claude token/cost accounting is not directly comparable. Missing cost is unknown, never zero."] });
    for (const entry of plan) {
      if (controller.signal.aborted) break;
      let f;
      let result;
      const started = Date.now();
      try {
        f = await createEvalFixture(entry.caseId);
        const common = { effort: options.effort, timeoutMs: options.timeoutMs, signal: controller.signal };
        result = entry.arm === "codex-shared" ? await runCodexEval(f, { ...common, model: options.codexModel })
          : await runClaudeEval(f, { ...common, model: options.claudeModel, surface: entry.arm === "claude-baseline" ? "baseline" : "shared" });
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
          wallMs: Date.now() - started };
      } finally { f?.dispose(); }
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
