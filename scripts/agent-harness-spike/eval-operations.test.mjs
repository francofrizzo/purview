import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createEvalFixture } from "./eval-fixture.mjs";
import { createReviewOperations } from "./eval-operations.mjs";
import { appendEvent, readEvents, toRevisionFiles } from "../../packages/core/dist/index.js";
import { addComment, readComments, writeComments } from "../../packages/server/dist/comments.js";

async function setup(t, id = "code-investigation", extra = {}) {
  const f = await createEvalFixture(id);
  t.after(() => f.dispose());
  return { f, ops: createReviewOperations({ ...f, ...extra }) };
}

test("shared exploration reads head/base, searches outside diff and confines paths/symlinks", async t => {
  const { f, ops } = await setup(t);
  const found = await ops.execute("search_code", { patterns: ["missing", "41 + seats"], include: "src/**", context: 1 });
  assert.deepEqual(found.items.map(m => [m.file, m.line]), [["src/pricing.js", 2]]);
  assert.deepEqual((await ops.execute("search_code", { patterns: ["price"], exclude: ["**/pricing.js"] })).items.map(m => m.file), ["src/invoice.js", "src/invoice.js"]);
  assert.match((await ops.execute("read_code", { path: "src/invoice.js", start: 2, limit: 1 })).items[0].text, /9/);
  assert.match((await ops.execute("read_base_file", { path: "src/invoice.js", start: 2, limit: 1 })).items[0].text, /2/);
  fs.writeFileSync(path.join(f.root, "outside.txt"), "not permitted");
  fs.symlinkSync(path.join(f.root, "outside.txt"), path.join(f.checkout, "escape"));
  for (const file of ["../outside.txt", path.join(f.root, "outside.txt"), "escape", ".git/config"]) {
    await assert.rejects(ops.execute("read_code", { path: file }), e => e.code === "outside_checkout");
  }
});

test("diff pagination is complete, bounded and rejects changed-query or changed-content cursors", async t => {
  const { ops } = await setup(t, "large-diff-read");
  let result = await ops.execute("review_diff", { limit: 100 });
  const snapshot = result.snapshot;
  const rows = [...result.items];
  assert.ok(!JSON.stringify(result.items).includes("tailInvoice"));
  await assert.rejects(ops.execute("review_diff", { cursor: result.nextCursor, selectors: ["src/invoice.js"] }), e => e.code === "stale_cursor");
  while (result.nextCursor) {
    result = await ops.execute("review_diff", { limit: 100, cursor: result.nextCursor });
    assert.equal(result.snapshot, snapshot);
    assert.ok(JSON.stringify(result.items).length < 25000);
    rows.push(...result.items);
  }
  assert.equal(rows.length, result.total);
  assert.ok(rows.some(r => r.text.includes("tailInvoice")));
  const { f, ops: other } = await setup(t);
  const first = await other.execute("read_code", { path: "src/pricing.js", limit: 1 });
  fs.appendFileSync(path.join(f.checkout, "src/pricing.js"), "// changed\n");
  await assert.rejects(other.execute("read_code", { path: "src/pricing.js", cursor: first.nextCursor }), e => e.code === "stale_cursor");
});

test("chat operations use real comment validation and do not mutate foreign, human, published or revoked drafts", async t => {
  const { f, ops } = await setup(t, "draft-comment");
  await assert.rejects(ops.execute("create_draft", { file: f.anchor.file, line: 999, body: "invalid" }), e => e.code === "comment_outside_diff");
  const body = "Please confirm the archive seat increase from 2 to 9 is intentional.";
  const { comment } = await ops.execute("create_draft", { ...f.anchor, subjectType: undefined, body });
  assert.equal(f.grade("").pass, true);
  await ops.execute("edit_draft", { id: comment.id, body: "edited" });
  assert.equal(readComments(f.key, f.root)[0].body, "edited");
  const human = addComment(f.key, { ...f.anchor, body: "human" }, f.root);
  await assert.rejects(ops.execute("edit_draft", { id: human.id, body: "forbidden" }), e => e.code === "consent_required");
  await assert.rejects(ops.execute("delete_draft", { id: "foreign" }), e => e.code === "outside_review");
  writeComments(f.key, readComments(f.key, f.root).map(c => c.id === comment.id ? { ...c, status: "submitted" } : c), f.root);
  await assert.rejects(ops.execute("delete_draft", { id: comment.id }), e => e.code === "not_draft");
  await assert.rejects(ops.execute("set_analysis", {}), e => e.code === "operation_not_granted");
  ops.revoke();
  await assert.rejects(ops.execute("create_draft", { ...f.anchor, body: "late" }), e => e.code === "revoked");
  assert.equal(readComments(f.key, f.root).length, 2);
});

test("analysis validates payloads with real core service and stale revision blocks writes", async t => {
  const { f, ops } = await setup(t, "initial-analysis");
  const before = readEvents(f.key, f.root).length;
  await assert.rejects(ops.execute("set_analysis", { summary: "bad", units: [], unassigned: [] }), /does not cover/);
  assert.equal(readEvents(f.key, f.root).length, before);
  const unit = { id: "invoice", title: "Invoice", summary: "Billing", kind: "core-logic", attention: "must-read", attentionWhy: "Seat change", order: 1,
    hunks: f.hunkIds, findings: [{ severity: "warning", text: "archive total changes from 55 to 104", evidence: "src/invoice.js:2, src/pricing.js:2" }] };
  const result = await ops.execute("set_analysis", { summary: "Billing", units: [unit] });
  assert.deepEqual(result.coverage.missing, []);
  assert.equal(f.grade("").pass, true);
  await assert.rejects(ops.execute("create_draft", {}), e => e.code === "operation_not_granted");
  const beforePatch = readEvents(f.key, f.root).length;
  await assert.rejects(ops.execute("patch_units", { units: [{ id: "invoice", patch: { summary: "must not write" } }, { id: "new", patch: { summary: "incomplete" } }] }));
  assert.equal(readEvents(f.key, f.root).length, beforePatch);
  await ops.execute("patch_units", { units: [{ id: "invoice", patch: { summary: "updated" } }] });
  appendEvent(f.key, { type: "revision-added", revision: 2, ...f.shas, baseOnly: false, files: toRevisionFiles(f.files) }, f.root);
  const beforeStale = readEvents(f.key, f.root).length;
  await assert.rejects(ops.execute("patch_units", { units: [{ id: "invoice", patch: { summary: "stale" } }] }), e => e.code === "stale_revision");
  assert.equal(readEvents(f.key, f.root).length, beforeStale);
});
