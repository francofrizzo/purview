import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { EVAL_CASES, createEvalFixture } from "./eval-fixture.mjs";
import { loadState, readDiff, setAnalysis } from "../../packages/core/dist/index.js";
import { addComment } from "../../packages/server/dist/comments.js";

async function fixture(t, id) {
  const f = await createEvalFixture(id);
  t.after(() => f.dispose());
  return f;
}

test("fresh isolated real stores and Git repos, cleanup and invalid id", async t => {
  assert.equal(EVAL_CASES.length, 4);
  await assert.rejects(createEvalFixture("missing"), /Unknown/);
  const a = await fixture(t, "code-investigation");
  const b = await fixture(t, "code-investigation");
  assert.notEqual(a.root, b.root);
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: a.checkout, encoding: "utf8" }).trim(), a.shas.headSha);
  assert.equal(readDiff(a.key, 1, a.root), a.patch);
  assert.equal(loadState(a.key, a.root).currentRevision, 1);
  assert.ok(!a.patch.includes("41 + seats"), "helper really is outside the diff");
  addComment(a.key, { ...a.anchor, body: "isolated" }, a.root);
  assert.equal(b.grade({ symbol: "price", before: 55, after: 104 }).pass, true);
  a.dispose(); a.dispose();
  assert.equal(fs.existsSync(a.root), false);
});

test("investigation requires asymmetric helper totals, not claims or wrong branch", async t => {
  const f = await fixture(t, "code-investigation");
  assert.equal(f.grade({ symbol: "price", before: 55, after: 104 }).pass, true);
  for (const a of [undefined, null, "null", "done", { symbol: "price", before: 19, after: 40 }, { symbol: "invoice", before: 55, after: 104 }]) {
    assert.equal(f.grade(a).pass, false);
  }
  assert.equal(f.grade(JSON.stringify({ symbol: "price", before: 55, after: 104 })).pass, true);
});

test("draft grader reads persisted comments, rejects wrong anchor/body and duplicates", async t => {
  const body = "Please confirm the archive seat increase from 2 to 9 is intentional.";
  const f = await fixture(t, "draft-comment");
  assert.equal(f.grade("created draft").pass, false);
  addComment(f.key, { ...f.anchor, body }, f.root, { agent: "eval" });
  assert.equal(f.grade("").pass, true);
  addComment(f.key, { ...f.anchor, body }, f.root);
  assert.equal(f.grade({}).checks.oneComment, false);
  for (const input of [{ ...f.anchor, line: 1, body }, { ...f.anchor, body: "wrong" }, { ...f.anchor, audience: "agent", body }]) {
    const other = await fixture(t, "draft-comment");
    addComment(other.key, input, other.root);
    assert.equal(other.grade({}).pass, false);
  }
});

test("analysis needs real coverage AND concrete finding, not answer counters", async t => {
  const f = await fixture(t, "initial-analysis");
  assert.equal(f.grade({ covered: 1, findings: 1 }).pass, false);
  const unit = { id: "invoice", title: "Invoice", summary: "Seat change", kind: "core-logic", attention: "must-read", attentionWhy: "Billing behavior", riskFlags: [], order: 1, hunks: f.hunkIds.map(id => ({ id })) };
  const store = u => setAnalysis(f.key, { summary: "Archive invoice seat change", units: [u], unassigned: [] }, {}, f.root);
  store(unit);
  assert.equal(f.grade({}).checks.coverage, true);
  assert.equal(f.grade({}).pass, false);
  const finding = { severity: "warning", text: "The archive invoice increases from 55 to 104; confirm billing intent.", evidence: "src/invoice.js:2, src/pricing.js:2" };
  store({ ...unit, findings: [finding] });
  assert.equal(f.grade("irrelevant").pass, true);
  store({ ...unit, findings: [{ ...finding, text: "archive invoice increases from 19 to 40" }] });
  assert.equal(f.grade({}).pass, false);
  store({ ...unit, findings: [{ ...finding, evidence: "src/invoice.js:2" }] });
  assert.equal(f.grade({}).pass, false);
});

test("large diff is pageable and tail answer depends on unchanged branch", async t => {
  const f = await fixture(t, "large-diff-read");
  assert.ok(Buffer.byteLength(f.patch) >= 100 * 1024);
  const pages = f.patch.match(/[\s\S]{1,8192}/g);
  assert.ok(pages.length > 12);
  assert.ok(!pages[0].includes("tailInvoice"));
  assert.ok(f.patch.indexOf("tailInvoice") > 100 * 1024);
  assert.equal(f.grade({ symbol: "tailInvoice", tier: "archive", seats: 17, total: 160 }).pass, true);
  for (const total of [64, 104, 0]) assert.equal(f.grade({ symbol: "tailInvoice", tier: "archive", seats: 17, total }).pass, false);
  assert.equal(f.grade({ symbol: "tailInvoice", tier: "live", seats: 17, total: 160 }).pass, false);
});
