import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { appendEvent, writeMeta, writeRevision, parseDiff, toRevisionFiles, loadState, analysisCoverage, duplicateHunks,
  setAnalysis, migrate, writeMigrationReport, remainingWorkFor } from "../../packages/core/dist/index.js";
import { readComments } from "../../packages/server/dist/comments.js";

export const EVAL_CASES = Object.freeze([
  { id: "code-investigation", task: "chat", description: "Trace an unchanged asymmetric pricing helper outside the diff." },
  { id: "draft-comment", task: "chat", description: "Persist exactly one draft at a specified diff anchor." },
  { id: "initial-analysis", task: "analysis", description: "Cover the diff and record a concrete, independently reproducible pricing finding." },
  { id: "large-diff-read", task: "chat", description: "Read a paginable >100KB diff and resolve a tail record through unchanged code." },
  { id: "incremental-analysis", task: "analysis", optional: true, description: "Patch a real r1→r2 migration, retaining unchanged units and rechecking changed findings." },
  { id: "resumed-incremental", task: "analysis", optional: true, description: "Cold-resume a shared-tool session after migration, with a fresh revision-bound grant." },
  { id: "documented-api-contradiction", task: "analysis", optional: true, description: "Persist a material documentation/API contradiction verified against unchanged code." },
  { id: "large-documented-api-contradiction", task: "analysis", optional: true, description: "Find the same contradiction among 162 coherent documentation hunks; report grouping only as a metric." },
]);

// Coverage here measures bookkeeping only, NOT general review quality.
const limitations = Object.freeze([
  "Synthetic local tasks; no claim about general review quality or model tool-use causality.",
  "Finding grading uses bounded semantic tokens, not natural-language entailment; paraphrases may fail.",
  "Incremental/resume cases are optional and do not change the original four-case matrix.",
]);

function answerObject(answer) {
  if (typeof answer === "string") {
    try { return answerObject(JSON.parse(answer)); } catch { return {}; }
  }
  return answer && typeof answer === "object" ? answer : {};
}

/**
 * Async factory; all disk APIs and grade() are synchronous. root is the Purview
 * store root AND disposable parent of checkout; always pass root explicitly to
 * services. checkout is a real Git repo at head (two commits, three for r2). key/revision bind
 * operations. patch/files/hunkIds/shas/anchor are runner context, NOT submitted
 * answers. grade accepts a JSON string or object (analysis/draft ignore it).
 * dispose is idempotent. Call once per arm/repetition; never reuse a fixture.
 */
export async function createEvalFixture(caseId, { revision: startRevision = 2 } = {}) {
  const spec = EVAL_CASES.find(c => c.id === caseId);
  if (!spec) throw new Error(`Unknown evaluation case: ${caseId}`);
  const incremental = ["incremental-analysis", "resumed-incremental"].includes(caseId);
  const documentation = ["documented-api-contradiction", "large-documented-api-contradiction"].includes(caseId);
  const largeDocumentation = caseId === "large-documented-api-contradiction";
  if (incremental && ![1, 2].includes(startRevision)) throw new Error("Incremental fixture starts at revision 1 or 2");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "purview-eval-")));
  const dispose = () => fs.rmSync(root, { recursive: true, force: true });
  try {
    const checkout = path.join(root, "checkout");
    fs.mkdirSync(path.join(checkout, "src"), { recursive: true });
    const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
      cwd: checkout, encoding: "utf8", timeout: 10000, maxBuffer: 4 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LANG: "C.UTF-8" },
    }).trim();
    git("init", "--quiet");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    const write = (name, text) => fs.writeFileSync(path.join(checkout, name), text);
    write("src/pricing.js", 'export function price(tier, seats) {\n  return tier === "archive" ? 41 + seats * 7 : 13 + seats * 3;\n}\n');
    write("src/invoice.js", 'import { price } from "./pricing.js";\nexport const invoice = () => price("archive", 2);\n');
    if (documentation) {
      write("src/archive.js", 'export function openArchive({ accountId, retentionDays }) {\n  if (!accountId || retentionDays < 7) throw new Error("Invalid archive policy");\n  return { accountId, retentionDays };\n}\nexport function openLive(accountId) { return { accountId }; }\n');
      fs.mkdirSync(path.join(checkout, "docs/archive"), { recursive: true });
      write("docs/archive/quickstart.md", '# Archive quickstart\nUse the archive API to create a retention policy.\n');
      if (largeDocumentation) {
        for (const topic of ["archive", "live", "operations"]) {
          fs.mkdirSync(path.join(checkout, `docs/${topic}`), { recursive: true });
          for (let i = 0; i < 54; i++) {
            if (topic === "archive" && i === 0) continue;
            write(`docs/${topic}/guide-${i}.md`, `# ${topic} guide ${i}\nConsult the service API.\n`);
          }
        }
      }
    }
    if (incremental) {
      write("src/stable.js", "export const limit = 3;\n");
      write("src/retired.js", "export const retired = false;\n");
    }
    git("add", "."); git("commit", "--quiet", "-m", "base");
    const baseSha = git("rev-parse", "HEAD");
    if (documentation) {
      write("docs/archive/quickstart.md", '# Archive quickstart\nCreate a 23-day archive for account acct-81 with openLegacyArchive("acct-81", 23), exported by src/archive.js.\n');
      if (largeDocumentation) {
        for (const topic of ["archive", "live", "operations"]) {
          for (let i = 0; i < 54; i++) {
            if (topic === "archive" && i === 0) continue;
            write(`docs/${topic}/guide-${i}.md`, `# ${topic} guide ${i}\n${topic === "archive" ? 'Use openArchive({ accountId: "acct-81", retentionDays: 23 }) from src/archive.js.' : topic === "live" ? 'Use openLive("acct-17") from src/archive.js; live accounts have no retention policy.' : 'Archive retentionDays must be at least 7; an accountId is required, as validated by src/archive.js.'}\n`);
          }
        }
      }
    } else write("src/invoice.js", 'import { price } from "./pricing.js";\nexport const invoice = () => price("archive", 9);\n');
    if (incremental) {
      write("src/stable.js", "export const limit = 5;\n");
      write("src/retired.js", "export const retired = true;\n");
    }
    if (caseId === "large-diff-read") {
      const rows = Array.from({ length: 2400 }, (_, i) => `export const row${i} = { tier: "live", seats: 2, label: "padding-${i}-abcdefghijklmnop" };`);
      rows.push('export const tailInvoice = { tier: "archive", seats: 17 };');
      write("src/batch.js", rows.join("\n") + "\n");
    }
    git("add", "."); git("commit", "--quiet", "-m", "change invoice");
    const headSha = git("rev-parse", "HEAD");
    let patch = git("diff", "--no-ext-diff", "--no-renames", baseSha, headSha) + "\n";
    let files = parseDiff(patch);
    let hunkIds = files.flatMap(f => f.hunks.map(h => h.id));
    const key = { host: "github.com", owner: "eval", repo: "synthetic", number: 19 };
    let revision = 1;
    let shas = { baseSha, headSha, mergeBase: baseSha };
    const identity = { ...key, url: "https://github.com/eval/synthetic/pull/19", title: "Change archive invoice seats" };
    writeMeta(key, { ...identity, createdAt: new Date().toISOString() }, root);
    appendEvent(key, { type: "pr-initialized", ...identity }, root);
    writeRevision(key, revision, patch, files, shas, root);
    appendEvent(key, { type: "revision-added", revision, ...shas, baseOnly: false, files: toRevisionFiles(files) }, root);
    let stableUnit;
    if (incremental) {
      const units = files.map((file, order) => ({ id: file.path === "src/invoice.js" ? "invoice" : file.path === "src/stable.js" ? "stable" : "retired",
        title: file.path, summary: `Review of ${file.path}`, kind: "core-logic", attention: "must-read", attentionWhy: "Behavior change",
        order, hunks: file.hunks.map(h => h.id), findings: [{ severity: "warning",
          text: file.path === "src/invoice.js" ? "archive total changes from 55 to 104" : `Verify ${file.path} intent`,
          evidence: file.path === "src/invoice.js" ? "src/invoice.js:2, src/pricing.js:2" : `${file.path}:1` }] }));
      setAnalysis(key, { summary: "Archive billing, limit and retired flag", units, unassigned: [] }, {}, root);
      stableUnit = structuredClone(loadState(key, root).units.find(u => u.id === "stable"));
    }
    const anchor = { file: "src/invoice.js", subjectType: "line", line: 2, side: "RIGHT" };
    const prompts = {
      "code-investigation": 'Trace invoice and its implementation, including unchanged files. Return only JSON {"symbol":string,"before":number,"after":number}, where symbol is the helper name and before/after are invoice totals.',
      "draft-comment": 'Create exactly ONE local github-audience draft on src/invoice.js RIGHT line 2 (single line). Body must be exactly: "Please confirm the archive seat increase from 2 to 9 is intentional." Do not publish or create other drafts.',
      "initial-analysis": 'Analyze this diff and persist a complete analysis with no unassigned hunks. Check unchanged pricing code. Record a warning finding on the invoice unit with before/after numeric totals and evidence naming src/invoice.js and src/pricing.js; mention archive. Do not create comments. Coverage alone is not a finding.',
      "large-diff-read": 'Read the complete diff, paging as needed. Resolve tailInvoice using the unchanged pricing helper. Return only JSON {"symbol":"tailInvoice","tier":string,"seats":number,"total":number}.',
      "incremental-analysis": 'Refresh the existing analysis for revision 2 using unit patches, NOT a full replacement. Inspect migration and remaining work, units, changed diff and unchanged pricing code. Preserve unit IDs and the stable unit exactly. Recheck the invoice finding against base and current totals, with evidence naming src/invoice.js and src/pricing.js and archive. Classify the new fee hunk into a new unit describing its numeric value. Patch the retired unit with a revision-2 changelog entry explaining its removal, but retain it as an empty removed unit without findings. Patch every changed unit, leave no unassigned or unclassified hunks, and save a revision summary. Do not create comments.',
    };
    if (incremental) prompts["incremental-analysis"] += ' A unit patch uses the regular unit fields plus changelogEntry (a string), not the persisted changelog array.';
    prompts["resumed-incremental"] = prompts["incremental-analysis"];
    const documentationPrompt = 'Review the documentation diff against the current checkout and persist a complete analysis with no unassigned hunks. Use the fewest coherent review decisions. Persist verified, sourced, material problems as findings on the relevant unit, with file:line evidence for the changed documentation and the implementation. A summary alone does not record a finding. Do not emit each successful verification: trivial confirmations and unverifiable speculation are not findings. Do not create comments.';
    prompts["documented-api-contradiction"] = documentationPrompt;
    prompts["large-documented-api-contradiction"] = documentationPrompt;
    const grade = answer => {
      const state = loadState(key, root);
      const comments = readComments(key, root);
      const a = answerObject(answer);
      const checks = { revision: state.currentRevision === revision };
      if (caseId === "draft-comment") {
        checks.oneComment = comments.length === 1;
        const c = comments[0];
        checks.anchor = !!c && Object.entries(anchor).every(([k, v]) => c[k] === v) && c.startLine === undefined && !c.inReplyTo;
        checks.draft = c?.status === "draft" && c?.audience === "github";
        checks.body = c?.body === "Please confirm the archive seat increase from 2 to 9 is intentional.";
      } else {
        checks.noComments = comments.length === 0;
        if (incremental) {
          const coverage = analysisCoverage(state, { units: state.units, unassigned: state.unassignedHunkIds });
          const remaining = remainingWorkFor(key, root);
          checks.coverage = coverage.missing.length === 0 && coverage.unknown.length === 0 && state.unassignedHunkIds.length === 0 && duplicateHunks({ units: state.units }).length === 0;
          checks.remaining = remaining.needsClassification.length === 0 && remaining.unpatchedChanged?.length === 0;
          checks.stablePreserved = JSON.stringify(state.units.find(u => u.id === "stable")) === JSON.stringify(stableUnit);
          const invoice = state.units.find(u => u.id === "invoice");
          const invoiceId = files.find(f => f.path === "src/invoice.js").hunks[0].id;
          checks.invoice = invoice?.hunks.some(h => h.id === invoiceId) && invoice.findings?.some(f =>
            f.severity === "warning" && /\b55\b/.test(f.text) && /\b69\b/.test(f.text) && !/\b104\b/.test(f.text) && /archive/i.test(f.text) &&
            f.evidence.includes("src/invoice.js") && f.evidence.includes("src/pricing.js")) === true;
          const retired = state.units.find(u => u.id === "retired");
          checks.retired = retired?.removedAtRevision === 2 && retired.hunks.length === 0 && !retired.findings?.length &&
            retired.changelog?.some(c => c.revision === 2 && /remov|retir|drop/i.test(c.text)) === true;
          const feeId = files.find(f => f.path === "src/fees.js")?.hunks[0].id;
          checks.fee = !!feeId && state.units.some(u => u.hunks.some(h => h.id === feeId) && /\b11\b/.test(u.summary));
          checks.partialUpdate = state.analysisRevision === 1;
          checks.revisionSummary = !!state.revisions.find(r => r.revision === 2)?.summary?.trim();
        } else if (documentation) {
          const coverage = analysisCoverage(state, { units: state.units, unassigned: state.unassignedHunkIds });
          checks.analysisStored = state.analysisRevision === revision && state.summary.trim().length > 0;
          checks.coverage = coverage.missing.length === 0 && coverage.unknown.length === 0 && state.unassignedHunkIds.length === 0 && duplicateHunks({ units: state.units }).length === 0;
          const docIds = files.find(f => f.path === "docs/archive/quickstart.md").hunks.map(h => h.id);
          checks.finding = state.units.some(u => u.hunks.some(h => docIds.includes(h.id)) && u.findings?.some(f =>
            ["warning", "critical"].includes(f.severity) &&
            /\bopenLegacyArchive\b/.test(f.text) &&
            /\b(not exported|does not exist|missing export|no longer exists|no longer exported|removed|nonexistent|unavailable)\b/i.test(f.text) &&
            /\bopenArchive\b/.test(f.text) && /\baccountId\b/.test(f.text) && /\bretentionDays\b/.test(f.text) &&
            /docs\/archive\/quickstart\.md:2\b/.test(f.evidence) && /src\/archive\.js:1\b/.test(f.evidence)));
        } else if (caseId === "initial-analysis") {
          const coverage = analysisCoverage(state, { units: state.units, unassigned: state.unassignedHunkIds });
          checks.analysisStored = state.analysisRevision === revision && state.summary.trim().length > 0;
          checks.coverage = coverage.missing.length === 0 && coverage.unknown.length === 0 && state.unassignedHunkIds.length === 0 && duplicateHunks({ units: state.units }).length === 0;
          const invoiceIds = files.filter(f => f.path === "src/invoice.js").flatMap(f => f.hunks.map(h => h.id));
          checks.finding = state.units.some(u => u.hunks.some(h => invoiceIds.includes(h.id)) && u.findings?.some(f => f.severity === "warning" && /\b55\b/.test(f.text) && /\b104\b/.test(f.text) && /archive/i.test(f.text) && f.evidence.includes("src/invoice.js") && f.evidence.includes("src/pricing.js")));
        } else if (caseId === "code-investigation") {
          checks.symbol = a.symbol === "price";
          checks.totals = a.before === 55 && a.after === 104;
          checks.noAnalysis = state.analysisRevision === undefined;
        } else {
          checks.tail = a.symbol === "tailInvoice" && a.tier === "archive" && a.seats === 17;
          checks.total = a.total === 160;
          checks.noAnalysis = state.analysisRevision === undefined;
        }
      }
      return { pass: Object.values(checks).every(Boolean), checks, limitations,
        ...(documentation ? { metrics: { unitCount: state.units.length, hunkCount: hunkIds.length, topicCount: largeDocumentation ? 3 : 1 } } : {}) };
    };
    const fixture = { root, checkout, key, revision, incremental, task: spec.task, prompt: prompts[caseId], dispose, grade, patch, files, hunkIds, shas, anchor, limitations };
    if (incremental) {
      fixture.advanceRevision = () => {
        if (revision !== 1) throw new Error("Fixture already migrated");
        const previous = loadState(key, root);
        const previousFiles = files;
        write("src/invoice.js", 'import { price } from "./pricing.js";\nexport const invoice = () => price("archive", 4);\n');
        write("src/retired.js", "export const retired = false;\n");
        write("src/fees.js", "export const fee = 11;\n");
        git("add", "."); git("commit", "--quiet", "-m", "revise invoice, drop retired change and add fee");
        revision = 2;
        shas = { ...shas, headSha: git("rev-parse", "HEAD") };
        patch = git("diff", "--no-ext-diff", "--no-renames", baseSha, shas.headSha) + "\n";
        files = parseDiff(patch);
        hunkIds = files.flatMap(f => f.hunks.map(h => h.id));
        writeRevision(key, revision, patch, files, shas, root);
        const migration = migrate({ revision, previousRevision: 1, previousFiles, nextFiles: files, hunkStates: previous.hunks, baseOnly: false });
        writeMigrationReport(key, migration, root);
        appendEvent(key, { type: "revision-added", revision, ...shas, baseOnly: false, files: toRevisionFiles(files), migration }, root);
        Object.assign(fixture, { revision, shas, patch, files, hunkIds });
      };
      if (startRevision === 2) fixture.advanceRevision();
    }
    return fixture;
  } catch (error) { dispose(); throw error; }
}
