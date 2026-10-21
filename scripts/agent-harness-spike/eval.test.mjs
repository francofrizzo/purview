import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseOptions, runPlan } from "./eval.mjs";
import { provider } from "./provider.mjs";
import { createEvalFixture } from "./eval-fixture.mjs";

const exec = promisify(execFile);
const runner = path.join(import.meta.dirname, "eval.mjs");

test("eval CLI is dry by default, rejects ambiguous paid options and pairs equal case counts", async () => {
  const options = parseOptions([]);
  assert.equal(options.run, false);
  assert.equal(parseOptions(["--runtime", "production"]).runtime, "production");
  assert.throws(() => parseOptions(["--runtime", "other"]));
  assert.throws(() => parseOptions(["--runtime", "production", "--arms", "claude-shared", "--cases", "resumed-incremental"]));
  const plan = runPlan(options);
  assert.equal(plan.length, 24);
  for (const id of options.cases) for (const arm of options.arms) {
    assert.equal(plan.filter(r => r.caseId === id && r.arm === arm).length, 3);
  }
  assert.notEqual(plan[0].arm, plan[2].arm);
  for (const args of [["--run"], ["--arms", "unknown"], ["--repeats", "0"], ["--repeats", "2.1"], ["--timeout-ms", "-1"], ["--cases", "draft-comment,draft-comment"]]) {
    assert.throws(() => parseOptions(args));
  }
  const { stdout } = await exec(process.execPath, [runner, "--list"]);
  assert.equal(JSON.parse(stdout).dryRun, true);
  assert.throws(() => parseOptions(["--cases", "resumed-incremental"]), /shared arms only/);
  const resumed = await exec(process.execPath, [runner, "--cases", "resumed-incremental", "--arms", "claude-shared", "--repeats", "1"]);
  assert.equal(JSON.parse(resumed.stdout).requests, 2, "one resumed case has two model turns");
});

test("real eval CLI saves functional outcomes and failures, with no paid provider or personal state", { timeout: 60000 }, async t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "purview-eval-cli-")));
  const api = await provider();
  t.after(async () => { await api.close(); fs.rmSync(home, { recursive: true, force: true }); });
  for (const runtime of ["spike", "production"]) for (const correct of [true, false]) {
    api.plan([{ text: JSON.stringify({ symbol: "price", before: 55, after: correct ? 104 : 40 }) }]);
    const out = path.join(home, `${runtime}-${correct}.jsonl`);
    const args = [runner, "--runtime", runtime, "--run", "--out", out, "--arms", "claude-shared", "--cases", "code-investigation", "--repeats", "1"];
    let exit = 0;
    try {
      await exec(process.execPath, args, { env: { PATH: process.env.PATH, HOME: home,
        PURVIEW_CLAUDE_BIN: path.join(import.meta.dirname, `node_modules/@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`),
        ANTHROPIC_API_KEY: "local-fixture-not-a-secret", ANTHROPIC_BASE_URL: api.url,
        HTTPS_PROXY: api.url, HTTP_PROXY: api.url, NO_PROXY: "127.0.0.1,localhost" }, timeout: 45000 });
    } catch (error) { exit = error.code; }
    assert.equal(exit, correct ? 0 : 1);
    const rows = fs.readFileSync(out, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(rows[0].type, "manifest");
    assert.equal(rows[1].pass, correct);
    assert.equal(rows[1].grading.checks.totals, correct);
    assert.equal(rows[2].arms["claude-shared"].failed, correct ? 0 : 1);
    assert.equal(fs.statSync(out).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(home, ".purview")), false);
    // A mistaken rerun may not overwrite an earlier report or request a model.
    const count = api.requests.length;
    await assert.rejects(exec(process.execPath, args, { env: { PATH: process.env.PATH, HOME: home } }));
    assert.equal(api.requests.length, count);
  }
});

test("eval CLI cold-resumes a real Claude session and reports both turns without session identifiers", { timeout: 60000 }, async t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "purview-eval-resume-cli-")));
  const api = await provider();
  t.after(async () => { await api.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const f = await createEvalFixture("resumed-incremental");
  const feeId = f.files.find(file => file.path === "src/fees.js").hunks[0].id;
  f.dispose();
  api.plan([{ tool: "review_context", args: {} }, { tool: "review_units", args: {} }, { tool: "review_diff", args: {} }, { text: "ready" },
    { tool: "patch_units", args: { units: [
      { id: "invoice", patch: { findings: [{ severity: "warning", text: "archive changes from 55 to 69", evidence: "src/invoice.js:2 src/pricing.js:2" }], changelogEntry: "Updated seats" } },
      { id: "retired", patch: { changelogEntry: "Removed flag change" } },
      { id: "fee", patch: { title: "Fee", summary: "Fee is 11", kind: "core-logic", attention: "must-read", attentionWhy: "Charge", order: 3, hunks: [feeId] } },
    ] } }, { tool: "set_revision_summary", args: { text: "Changed invoice, fee, retired flag" } }, { text: "updated" }]);
  const out = path.join(home, "resume.jsonl");
  await exec(process.execPath, [runner, "--run", "--out", out, "--arms", "claude-shared", "--cases", "resumed-incremental", "--repeats", "1"], {
    env: { PATH: process.env.PATH, HOME: home, ANTHROPIC_API_KEY: "local-fixture-not-a-secret", ANTHROPIC_BASE_URL: api.url,
      ENABLE_TOOL_SEARCH: "false", HTTPS_PROXY: api.url, HTTP_PROXY: api.url, NO_PROXY: "127.0.0.1,localhost" }, timeout: 45000 });
  const rows = fs.readFileSync(out, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows[1].pass, true);
  assert.equal(rows[1].resumedSameSession, true);
  assert.equal(rows[1].warmup.ok, true);
  assert.ok(rows[1].warmup.usage);
  assert.equal(rows[1].session, undefined);
  assert.equal(rows[2].arms["claude-shared"].passed, 1);
  api.plan([{ text: "ready without reading anything" }]);
  const count = api.requests.length;
  const failed = path.join(home, "failed-warmup.jsonl");
  await assert.rejects(exec(process.execPath, [runner, "--run", "--out", failed, "--arms", "claude-shared", "--cases", "resumed-incremental", "--repeats", "1"], {
    env: { PATH: process.env.PATH, HOME: home, ANTHROPIC_API_KEY: "local-fixture-not-a-secret", ANTHROPIC_BASE_URL: api.url,
      ENABLE_TOOL_SEARCH: "false", HTTPS_PROXY: api.url, HTTP_PROXY: api.url, NO_PROXY: "127.0.0.1,localhost" }, timeout: 45000 }));
  const failure = JSON.parse(fs.readFileSync(failed, "utf8").trim().split("\n")[1]);
  assert.equal(failure.pass, false);
  assert.equal(failure.phase, "warmup");
  assert.ok(failure.warmup.usage, "failed warmup must not disappear from quota accounting");
  assert.equal(api.requests.length, count + 1, "failed warmup must not start the second turn");
});
