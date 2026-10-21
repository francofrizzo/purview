import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { appendEvent, writeMeta, writeRevision, parseDiff, toRevisionFiles, loadState, analysisCoverage, duplicateHunks } from "../../packages/core/dist/index.js";
import { readComments } from "../../packages/server/dist/comments.js";

export const EVAL_CASES = Object.freeze([
  { id: "code-investigation", task: "chat", description: "Trace an unchanged asymmetric pricing helper outside the diff." },
  { id: "draft-comment", task: "chat", description: "Persist exactly one draft at a specified diff anchor." },
  { id: "initial-analysis", task: "analysis", description: "Cover the diff and record a concrete, independently reproducible pricing finding." },
  { id: "large-diff-read", task: "chat", description: "Read a paginable >100KB diff and resolve a tail record through unchanged code." },
]);

// Deliberately use the allowed large-diff fallback: incremental migration and
// partial-update semantics deserve a separate evaluation, not a fake r2 shape.
// Coverage here measures bookkeeping only, NOT general review quality.
const limitations = Object.freeze([
  "Synthetic local tasks; no claim about general review quality or model tool-use causality.",
  "Finding grading uses bounded semantic tokens, not natural-language entailment; paraphrases may fail.",
  "large-diff-read replaces incremental-analysis; migration/partial updates are not evaluated.",
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
 * services. checkout is a real two-commit Git repo at head. key/revision bind
 * operations. patch/files/hunkIds/shas/anchor are runner context, NOT submitted
 * answers. grade accepts a JSON string or object (analysis/draft ignore it).
 * dispose is idempotent. Call once per arm/repetition; never reuse a fixture.
 */
export async function createEvalFixture(caseId) {
  const spec = EVAL_CASES.find(c => c.id === caseId);
  if (!spec) throw new Error(`Unknown evaluation case: ${caseId}`);
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
    git("add", "."); git("commit", "--quiet", "-m", "base");
    const baseSha = git("rev-parse", "HEAD");
    write("src/invoice.js", 'import { price } from "./pricing.js";\nexport const invoice = () => price("archive", 9);\n');
    if (caseId === "large-diff-read") {
      const rows = Array.from({ length: 2400 }, (_, i) => `export const row${i} = { tier: "live", seats: 2, label: "padding-${i}-abcdefghijklmnop" };`);
      rows.push('export const tailInvoice = { tier: "archive", seats: 17 };');
      write("src/batch.js", rows.join("\n") + "\n");
    }
    git("add", "."); git("commit", "--quiet", "-m", "change invoice");
    const headSha = git("rev-parse", "HEAD");
    const patch = git("diff", "--no-ext-diff", "--no-renames", baseSha, headSha) + "\n";
    const files = parseDiff(patch);
    const hunkIds = files.flatMap(f => f.hunks.map(h => h.id));
    const key = { host: "github.com", owner: "eval", repo: "synthetic", number: 19 };
    const revision = 1;
    const shas = { baseSha, headSha, mergeBase: baseSha };
    const identity = { ...key, url: "https://github.com/eval/synthetic/pull/19", title: "Change archive invoice seats" };
    writeMeta(key, { ...identity, createdAt: new Date().toISOString() }, root);
    appendEvent(key, { type: "pr-initialized", ...identity }, root);
    writeRevision(key, revision, patch, files, shas, root);
    appendEvent(key, { type: "revision-added", revision, ...shas, baseOnly: false, files: toRevisionFiles(files) }, root);
    const anchor = { file: "src/invoice.js", subjectType: "line", line: 2, side: "RIGHT" };
    const prompts = {
      "code-investigation": 'Trace invoice and its implementation, including unchanged files. Return only JSON {"symbol":string,"before":number,"after":number}, where symbol is the helper name and before/after are invoice totals.',
      "draft-comment": 'Create exactly ONE local github-audience draft on src/invoice.js RIGHT line 2 (single line). Body must be exactly: "Please confirm the archive seat increase from 2 to 9 is intentional." Do not publish or create other drafts.',
      "initial-analysis": 'Analyze this diff and persist a complete analysis with no unassigned hunks. Check unchanged pricing code. Record a warning finding on the invoice unit with before/after numeric totals and evidence naming src/invoice.js and src/pricing.js; mention archive. Do not create comments. Coverage alone is not a finding.',
      "large-diff-read": 'Read the complete diff, paging as needed. Resolve tailInvoice using the unchanged pricing helper. Return only JSON {"symbol":"tailInvoice","tier":string,"seats":number,"total":number}.',
    };
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
        if (caseId === "initial-analysis") {
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
      return { pass: Object.values(checks).every(Boolean), checks, limitations };
    };
    return { root, checkout, key, revision, task: spec.task, prompt: prompts[caseId], dispose, grade, patch, files, hunkIds, shas, anchor, limitations };
  } catch (error) { dispose(); throw error; }
}
