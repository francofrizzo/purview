#!/usr/bin/env node
// Dev tool: walk the state dir and print where analysis runs spend their wall
// time. One row per PR that has a metrics-bearing analysis-job.json.
//
//   node scripts/analysis-metrics.mjs
//   PURVIEW_STATE_DIR=/path/to/state node scripts/analysis-metrics.mjs
//
// No dependencies beyond node: plain fs walk + JSON.parse, aligned columns,
// sorted by minutes spent (slowest last, so it scrolls into view).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root =
  process.env.PURVIEW_STATE_DIR ||
  process.env.REVIEWER_STATE_DIR ||
  path.join(os.homedir(), ".purview");

/** Every `<host>/<owner>/<repo>/<number>` dir under root that looks like a PR. */
function findPrDirs(dir, depth = 0) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    if (depth === 2 && /^[0-9]+$/.test(e.name)) {
      out.push(p);
      continue;
    }
    if (depth < 2) out.push(...findPrDirs(p, depth + 1));
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function sum(obj) {
  return Object.values(obj ?? {}).reduce((a, b) => a + (typeof b === "number" ? b : 0), 0);
}

function fmtPhase(phases) {
  if (!phases) return "-";
  const { firstInvestigationAt, firstWriteAt, setAnalysisAt } = phases;
  return [
    firstInvestigationAt !== undefined ? `inv@${firstInvestigationAt}` : null,
    firstWriteAt !== undefined ? `write@${firstWriteAt}` : null,
    setAnalysisAt !== undefined ? `set@${setAnalysisAt}` : null,
  ]
    .filter(Boolean)
    .join(" ") || "-";
}

if (!fs.existsSync(root)) {
  console.error(`no state dir at ${root}`);
  process.exit(1);
}

const rows = [];
for (const prDir of findPrDirs(root)) {
  const job = readJson(path.join(prDir, "analysis-job.json"));
  if (!job || !job.metrics) continue;

  const rel = path.relative(root, prDir);
  const [host, owner, repo, number] = rel.split(path.sep);
  const key = `${host}/${owner}/${repo}/${number}`;

  const filesJson = readJson(path.join(prDir, "revisions", String(job.revision), "files.json"));
  const hunks = filesJson
    ? (filesJson.files ?? []).reduce((n, f) => n + (f.hunks?.length ?? 0), 0)
    : "?";

  const m = job.metrics;
  const minutes = m.durationMs !== undefined ? m.durationMs / 60_000 : undefined;

  rows.push({
    key,
    revision: job.revision,
    hunks,
    status: job.status,
    minutes,
    turns: m.turns,
    cost: m.costUsd,
    cacheRead: m.usage?.cacheRead,
    readsFiles: (m.reads?.filesJson ?? 0) + (m.bash?.state ?? 0),
    bashGrepSed: (m.bash?.grep ?? 0) + (m.bash?.sed ?? 0),
    phases: fmtPhase(m.phases),
  });
}

rows.sort((a, b) => (a.minutes ?? -1) - (b.minutes ?? -1));

if (rows.length === 0) {
  console.log(`no metrics-bearing analysis-job.json found under ${root}`);
  process.exit(0);
}

const headers = [
  "key",
  "rev",
  "hunks",
  "status",
  "minutes",
  "turns",
  "cost",
  "cacheRead",
  "triage.reads",
  "bash.grep+sed",
  "phases",
];
const cells = rows.map((r) => [
  r.key,
  String(r.revision),
  String(r.hunks),
  r.status,
  r.minutes !== undefined ? r.minutes.toFixed(1) : "-",
  r.turns !== undefined ? String(r.turns) : "-",
  r.cost !== undefined ? `$${r.cost.toFixed(2)}` : "-",
  r.cacheRead !== undefined ? String(r.cacheRead) : "-",
  String(r.readsFiles),
  String(r.bashGrepSed),
  r.phases,
]);

const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
const printRow = (cols) => console.log(cols.map((c, i) => c.padEnd(widths[i])).join("  "));

printRow(headers);
printRow(widths.map((w) => "-".repeat(w)));
for (const row of cells) printRow(row);
