import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
function run(file, args, env = {}) {
  return new Promise(resolve => {
    const c = spawn(process.execPath, [path.join(here, file), ...args], { env: { ...process.env, ...env } });
    let output = "";
    c.stdout.on("data", x => output += x); c.stderr.on("data", x => output += x);
    c.on("close", code => resolve({ code, output }));
  });
}
test("prepare pins local agents, preserves paths/overlays, rejects destructive destinations", async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "realpr-test-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const src = path.join(tmp, "source"), repo = "example.test/o/r", pr = path.join(src, repo, "1");
  fs.mkdirSync(pr, { recursive: true });
  fs.writeFileSync(path.join(src, "config.json"), JSON.stringify({ lan: { token: "PRIVATE" } }));
  fs.writeFileSync(path.join(src, repo, "repo.json"), JSON.stringify({ repoPath: "/dedicated", rubric: "PRIVATE", analysisAgent: { harness: "wrong" } }));
  fs.writeFileSync(path.join(src, repo, "RUBRIC.local.md"), "PRIVATE");
  for (const f of ["meta.json", "chat.json", "analysis-job.json", "team-config.json"]) fs.writeFileSync(path.join(pr, f), "PRIVATE");
  const out = path.join(tmp, "out"), env = { PURVIEW_STATE_DIR: src };
  assert.equal((await run("prepare.mjs", [out, repo, "1"], env)).code, 0);
  for (const arm of ["claude-code", "claude-shared", "codex"]) {
    const root = path.join(out, arm), local = JSON.parse(fs.readFileSync(path.join(root, repo, "repo.json")));
    assert.equal(local.analysisAgent.harness, arm); assert.equal(local.chatAgent.harness, arm);
    assert.equal(local.repoPath, "/dedicated"); assert.equal(local.autoAnalyze, false);
    assert.equal(fs.readFileSync(path.join(root, repo, "RUBRIC.local.md"), "utf8"), "PRIVATE");
    assert.equal(fs.existsSync(path.join(root, repo, "1/chat.json")), false);
    assert.equal(fs.readFileSync(path.join(root, repo, "1/team-config.json"), "utf8"), "PRIVATE");
  }
  for (const target of [out, src, path.join(src, "nested"), tmp]) assert.notEqual((await run("prepare.mjs", [target, repo, "1"], env)).code, 0);
  assert.notEqual((await run("prepare.mjs", [path.join(tmp, "bad"), "../o/r", "1"], env)).code, 0);
  fs.symlinkSync(src, path.join(pr, "link"));
  assert.notEqual((await run("prepare.mjs", [path.join(tmp, "symlink"), repo, "1"], env)).code, 0);
  assert.equal(fs.readFileSync(path.join(pr, "chat.json"), "utf8"), "PRIVATE");
});
test("clients reject dangerous ports without contacting a server", async () => {
  for (const file of ["drive.mjs", "chat.mjs"]) for (const port of ["4779", "0", "65536", "abc", "80"]) assert.notEqual((await run(file, [port, "example.test/o/r", "1", "codex"])).code, 0);
});
test("HTTP contract: run metadata, privacy, mismatch gating, Stop then continuation", async t => {
  const agent = { harness: "codex", model: "gpt-6.1-sol", sources: { harness: "repo", model: "repo" } };
  let mismatch = false, badRun = false, failed = false, uncovered = false, earlyStop = false, analyzed = 0, turns = 0, messages = [], comments = [], pending;
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* consume request */ }
    res.setHeader("content-type", "application/json");
    const send = x => res.end(JSON.stringify(x));
    if (req.url.endsWith("/config")) return send({ effective: { autoAnalyze: false, analysisAgent: mismatch ? { ...agent, harness: "wrong" } : agent, chatAgent: agent } });
    if (req.url.endsWith("/analyze")) { analyzed++; return send({ job: { revision: 1, queuedAt: "now" } }); }
    if (req.url.endsWith("/refresh")) return send({ noop: true, report: { private: "PRIVATE" } });
    if (req.url.endsWith("/comments")) return send({ comments });
    if (req.url.endsWith("/chat/stop")) {
      messages.push({ role: "assistant", text: "PRIVATE", interrupted: true });
      pending.end("PRIVATE"); pending = null;
      return send({ ok: true, message: { text: "PRIVATE" } });
    }
    if (req.url.endsWith("/chat") && req.method === "POST") {
      turns++; messages.push({ role: "user", text: "PRIVATE" });
      if (turns === 3 && !earlyStop) { pending = res; res.write("PRIVATE"); return; }
      messages.push({ role: "assistant", text: "PRIVATE" });
      if (turns === 2) comments.push({ id: "1", body: "PRIVATE", path: "PRIVATE", status: "draft", audience: "github" });
      return res.end("PRIVATE");
    }
    if (req.url.endsWith("/chat")) return send({ agent, sessionHarness: "codex", busy: !!pending, messages });
    send({ state: { currentRevision: 1, units: [{ title: "PRIVATE", findings: [] }], unassignedHunkIds: uncovered ? ["PRIVATE"] : [] }, analysisJob: { revision: 1, queuedAt: "now", status: failed ? "failed" : "done", error: "PRIVATE", metrics: { run: { ...agent, harness: badRun ? "wrong" : agent.harness, cwd: "PRIVATE", sessionId: "PRIVATE" }, usage: { input: 10 } } } });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const args = [String(server.address().port), "example.test/o/r", "1", "codex"];
  const result = await run("drive.mjs", args);
  assert.equal(result.code, 0, result.output); assert.doesNotMatch(result.output, /PRIVATE/); assert.match(result.output, /"input":10/);
  mismatch = true;
  assert.notEqual((await run("drive.mjs", args)).code, 0); assert.equal(analyzed, 1);
  mismatch = false;
  for (const flag of ["metadata", "failure", "coverage"]) {
    badRun = flag === "metadata"; failed = flag === "failure"; uncovered = flag === "coverage";
    const result = await run("drive.mjs", args);
    assert.notEqual(result.code, 0); assert.doesNotMatch(result.output, /PRIVATE/);
  }
  badRun = failed = uncovered = false;
  assert.equal((await run("drive.mjs", [...args, "refresh"])).code, 0);
  const chat = await run("chat.mjs", args);
  assert.equal(chat.code, 0, chat.output); assert.equal(turns, 4); assert.doesNotMatch(chat.output, /PRIVATE/); assert.match(chat.output, /"stopped":true/);
  turns = 0; comments = []; messages = []; earlyStop = true;
  assert.notEqual((await run("chat.mjs", args)).code, 0); assert.equal(turns, 3); assert.equal(pending, null);
});
