import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { EVAL_CASES, createEvalFixture } from "./eval-fixture.mjs";
import { loadState, readDiff, setAnalysis, setUnits, setRevisionSummary } from "../../packages/core/dist/index.js";
import { addComment } from "../../packages/server/dist/comments.js";

async function fixture(t, id, options) {
  const f = await createEvalFixture(id, options);
  t.after(() => f.dispose());
  return f;
}

test("fresh isolated real stores and Git repos, cleanup and invalid id", async t => {
  assert.equal(EVAL_CASES.filter(c => !c.optional).length, 4);
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

for (const graderVersion of [1, 2]) for (const id of ["documented-api-contradiction", "large-documented-api-contradiction"]) {
  test(`${id} v${graderVersion}: persisted material finding, asymmetric evidence and negative controls`, async t => {
    const f = await fixture(t, id, { graderVersion });
    assert.equal(EVAL_CASES.find(c => c.id === id).optional, true);
    assert.ok(f.files.every(file => file.path.endsWith(".md")));
    assert.equal(f.hunkIds.length, id.startsWith("large-") ? 162 : 1);
    const source = fs.readFileSync(`${f.checkout}/src/archive.js`, "utf8");
    assert.ok(source.includes("openArchive({ accountId, retentionDays })"));
    assert.ok(!source.includes("openLegacyArchive"));
    // Execute the unchanged implementation without packages or personal state.
    const api = await import(`data:text/javascript,${encodeURIComponent(source)}`);
    assert.deepEqual(api.openArchive({ accountId: "acct-81", retentionDays: 23 }), { accountId: "acct-81", retentionDays: 23 });
    assert.throws(() => api.openArchive("acct-81", 23), /Invalid/);
    assert.deepEqual(api.openLive("acct-17"), { accountId: "acct-17" });
    const finding = { severity: "warning", text: "openLegacyArchive is not exported; the quickstart call fails. Use openArchive with accountId and retentionDays instead.", evidence: "docs/archive/quickstart.md:2, src/archive.js:1" };
    const unit = { id: "docs", title: "Documentation", summary: "API guidance", kind: "docs", attention: "must-read", attentionWhy: "Executable quickstart", order: 0, hunks: f.hunkIds };
    const store = (findings, summary = "Documentation update", units = [{ ...unit, findings }]) => setAnalysis(f.key, { summary, units, unassigned: [] }, {}, f.root);
    assert.equal(f.grade({ findings: [finding] }).pass, false);
    store([]);
    assert.equal(f.grade({}).checks.coverage, true);
    assert.equal(f.grade({}).pass, false, "omission");
    store([], finding.text);
    assert.equal(f.grade({}).pass, false, "PR summary only");
    store([], "Documentation update", [{ ...unit, summary: finding.text }]);
    assert.equal(f.grade({}).pass, false, "unit summary only");
    for (const bad of [
      { ...finding, text: "openLegacyArchive is exported and valid; openArchive also accepts accountId and retentionDays." },
      { ...finding, text: "openLive is missing; use openArchive with accountId and retentionDays." },
      { ...finding, text: "Verified openArchive accepts accountId and retentionDays." },
      ...(graderVersion === 2 ? [
        { ...finding, text: "openLegacyArchive is valid. openArchive does not exist; it takes accountId and retentionDays." },
        { ...finding, text: "openLegacyArchive is not missing. openArchive takes accountId and retentionDays." },
        { ...finding, text: "The module exports only openArchive, openLive and openLegacyArchive; accountId and retentionDays work." },
      ] : []),
      { ...finding, text: "This change might cause outages in production." },
      { ...finding, severity: "note" },
      { ...finding, evidence: "docs/archive/quickstart.md:2" },
      { ...finding, evidence: "docs/live/guide-1.md:2, src/archive.js:1" },
      { ...finding, evidence: "docs/archive/quickstart.md:20, src/archive.js:10" },
    ]) {
      store([bad]);
      assert.equal(f.grade({}).pass, false, JSON.stringify(bad));
    }
    store([finding]);
    assert.equal(f.grade("answer ignored").pass, true);
    assert.equal(f.grade().graderVersion, graderVersion);
    const paraphrases = [
      "openLegacyArchive is prescribed, but src/archive.js does not export it; use openArchive instead.",
      "openLegacyArchive fails: the module exports only openArchive and openLive.",
      "The quickstart documents openLegacyArchive; that module has no such export. Use openArchive.",
    ];
    for (const text of paraphrases) {
      store([{ ...finding, text }]);
      assert.equal(f.grade().pass, graderVersion === 2, text);
    }
    store([finding]);
    assert.deepEqual(f.grade({}).metrics, { unitCount: 1, hunkCount: f.hunkIds.length, topicCount: id.startsWith("large-") ? 3 : 1 });
    if (id.startsWith("large-")) {
      const units = f.files.map((file, order) => ({ ...unit, id: `docs-${order}`, order, hunks: file.hunks.map(h => h.id), findings: file.path === "docs/archive/quickstart.md" ? [finding] : [] }));
      store([], "Documentation update", units);
      assert.equal(f.grade({}).pass, true, "granularity is not a quality threshold");
      assert.equal(f.grade({}).metrics.unitCount, 162);
      const wrong = units.find(u => u.findings.length);
      wrong.findings = [];
      units.find(u => u.id !== wrong.id).findings = [finding];
      store([], "Documentation update", units);
      assert.equal(f.grade({}).pass, false, "finding must belong to the affected hunk");
    }
  });
}

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

test("incremental grader requires real migration, corrected findings, retained stable unit and partial updates", async t => {
  const f = await fixture(t, "incremental-analysis");
  const state = loadState(f.key, f.root);
  assert.deepEqual(state.lastMigration.counts, { identical: 1, fuzzy: 1, renamed: 0, archived: 1, new: 1 });
  assert.ok(state.units.find(u => u.id === "stable").findings.length);
  assert.equal(state.units.find(u => u.id === "invoice").findings, undefined);
  assert.equal(state.units.find(u => u.id === "retired").findings, undefined);
  assert.equal(f.grade("complete").pass, false);
  const finding = { severity: "warning", text: "archive total changes from 55 to 69", evidence: "src/invoice.js:2, src/pricing.js:2" };
  const patches = [
    { unitId: "invoice", payload: { summary: "Updated archive seats", findings: [finding], changelogEntry: "Seats changed again" } },
    { unitId: "retired", payload: { changelogEntry: "Removed retired flag change" } },
    { unitId: "fee", payload: { title: "Fee", summary: "New fee of 11", kind: "core-logic", attention: "must-read", attentionWhy: "New charge", order: 3,
      hunks: [f.files.find(file => file.path === "src/fees.js").hunks[0].id] } },
  ];
  setUnits(f.key, [patches[2]], f.root);
  assert.equal(f.grade("").checks.remaining, false, "new coverage alone leaves changed units pending");
  setUnits(f.key, patches.slice(0, 2), f.root);
  setRevisionSummary(f.key, "Updated archive invoice; added fee; retired change removed", 2, f.root);
  assert.equal(f.grade("").pass, true, JSON.stringify(f.grade("")));
  setUnits(f.key, [{ unitId: "invoice", payload: { findings: [{ ...finding, text: "archive changes from 55 to 104" }] } }], f.root);
  assert.equal(f.grade("").checks.invoice, false, "old valid finding is no longer correct");
  setUnits(f.key, [{ unitId: "invoice", payload: { findings: [finding] } }], f.root);
  const complete = loadState(f.key, f.root);
  setAnalysis(f.key, { summary: complete.summary, units: complete.units.filter(u => u.hunks.length), unassigned: [] }, {}, f.root);
  assert.equal(f.grade("").checks.partialUpdate, false, "full replacement is not an incremental refresh");
});
