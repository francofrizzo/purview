import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseOptions, runPlan } from "./eval.mjs";
import { provider } from "./provider.mjs";

const exec = promisify(execFile);
const runner = path.join(import.meta.dirname, "eval.mjs");

test("eval CLI is dry by default, rejects ambiguous paid options and pairs equal case counts", async () => {
  const options = parseOptions([]);
  assert.equal(options.run, false);
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
});

test("real eval CLI saves functional outcomes and failures, with no paid provider or personal state", { timeout: 60000 }, async t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "purview-eval-cli-")));
  const api = await provider();
  t.after(async () => { await api.close(); fs.rmSync(home, { recursive: true, force: true }); });
  for (const correct of [true, false]) {
    api.plan([{ text: JSON.stringify({ symbol: "price", before: 55, after: correct ? 104 : 40 }) }]);
    const out = path.join(home, `${correct}.jsonl`);
    const args = [runner, "--run", "--out", out, "--arms", "claude-shared", "--cases", "code-investigation", "--repeats", "1"];
    let exit = 0;
    try {
      await exec(process.execPath, args, { env: { PATH: process.env.PATH, HOME: home,
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
