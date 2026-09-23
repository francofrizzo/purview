#!/usr/bin/env node
// Dev tool: walk the state dir and print what analysis runs cost, one row per
// run (every metrics-bearing `analysis-finished` event in every PR's log).
//
//   node scripts/analysis-metrics.mjs
//   node scripts/analysis-metrics.mjs --kind refresh --since 2026-09-01
//   node scripts/analysis-metrics.mjs --group model
//   node scripts/analysis-metrics.mjs --transcripts   # list session transcript paths
//   node scripts/analysis-metrics.mjs --json          # rows as JSON, for further analysis
//   PURVIEW_STATE_DIR=/path/to/state node scripts/analysis-metrics.mjs
//
// Flags:
//   --kind initial|refresh|rerun   only runs of that kind (runs from before
//                                  kinds were recorded never match)
//   --status done|failed|cancelled only runs that ended that way
//   --since DATE / --until DATE    by the run's finish time (any Date.parse-able value)
//   --pr TEXT                      only PR keys containing TEXT (e.g. "core/7651")
//   --prompt HASH                  only runs whose promptVersion starts with HASH
//   --group kind|model|effort|prompt|repo|status
//                                  one aggregate row per value instead of per run
//
// `minutes` is wall-clock time: the server's own bracket around the child
// process (`metrics.run.wallMs`). Runs recorded before that existed fall back
// to the CLI's `durationMs` and are marked `~`. `cli.min` is always the CLI's
// number; a run whose wall time exceeds it by more than half (and 2+ minutes)
// is flagged `!` in `gap` — the CLI does not count stalls.
//
// Size columns come from the run's own record (`metrics.run.size`) and fall
// back to the revision's files.json for runs recorded before that existed.
// `min/100L` and `$/100L` normalize by added+removed lines of the whole
// revision — for refresh runs, `mig` shows how much of it actually moved.
//
// Outcome columns (`corr`, `edits`) count what happened after a run and before
// the next run or revision: `classification-corrected` events, and
// `unit-updated` events whose patch sets kind or attention. The analysis
// agent's own set-unit calls always land between that run's
// `analysis-started` and `analysis-finished` (the finish is appended only after
// the child exits), so anything in the window is a human edit — from the UI,
// or from someone driving the CLI by hand. A UI edit made while a run was in
// flight falls inside the run's bracket and is not counted.
//
// No dependencies beyond node: plain fs walk + JSON.parse, aligned columns,
// sorted by finish time (newest last, so it scrolls into view).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const opts = { transcripts: false, json: false };
  const valued = new Set(["kind", "status", "since", "until", "pr", "prompt", "group"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--transcripts") opts.transcripts = true;
    else if (a === "--json") opts.json = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (a.startsWith("--") && valued.has(a.slice(2).split("=")[0])) {
      const [name, inline] = a.slice(2).split("=");
      const value = inline ?? argv[++i];
      if (value === undefined) fail(`--${name} needs a value`);
      opts[name] = value;
    } else fail(`unknown argument: ${a}`);
  }
  for (const k of ["since", "until"]) {
    if (opts[k] !== undefined && Number.isNaN(Date.parse(opts[k]))) fail(`--${k}: not a date: ${opts[k]}`);
  }
  const groups = ["kind", "model", "effort", "prompt", "repo", "status"];
  if (opts.group !== undefined && !groups.includes(opts.group)) {
    fail(`--group must be one of ${groups.join(", ")}`);
  }
  return opts;
}

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

/* ------------------------------------------------------------------ read */

/** Every `<host>/<owner>/<repo>/<number>` dir under root that looks like a PR
 *  (root is depth 0, so the number is at depth 3; managed checkouts are skipped). */
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
    if (depth === 3 && /^[0-9]+$/.test(e.name)) {
      out.push(p);
      continue;
    }
    if (depth < 3 && e.name !== "checkouts") out.push(...findPrDirs(p, depth + 1));
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

function readEvents(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a torn last line is not worth dying over */
    }
  }
  return out;
}

/** Size of a revision from its files.json, for runs that predate `run.size`. */
function sizeFromFiles(prDir, revision) {
  const filesJson = readJson(path.join(prDir, "revisions", String(revision), "files.json"));
  if (!filesJson) return undefined;
  const size = { files: 0, hunks: 0, added: 0, removed: 0 };
  for (const f of filesJson.files ?? []) {
    size.files++;
    for (const h of f.hunks ?? []) {
      size.hunks++;
      size.added += h.addedLines?.length ?? 0;
      size.removed += h.removedLines?.length ?? 0;
    }
  }
  return size;
}

/** Claude Code keeps a session under its cwd with every non-alphanumeric as "-". */
function transcriptPath(run) {
  if (!run?.sessionId || !run?.cwd) return undefined;
  return path.join(
    os.homedir(),
    ".claude",
    "projects",
    run.cwd.replace(/[^a-zA-Z0-9]/g, "-"),
    `${run.sessionId}.jsonl`,
  );
}

/** Human classification edits after `events[from]`, until the next run or revision. */
function outcomesAfter(events, from) {
  let corrections = 0;
  let edits = 0;
  for (let i = from + 1; i < events.length; i++) {
    const e = events[i];
    if (e.type === "analysis-started" || e.type === "revision-added") break;
    if (e.type === "classification-corrected") corrections++;
    else if (e.type === "unit-updated" && (e.patch?.kind !== undefined || e.patch?.attention !== undefined)) {
      edits++;
    }
  }
  return { corrections, edits };
}

function collectRuns(root) {
  const rows = [];
  for (const prDir of findPrDirs(root)) {
    const rel = path.relative(root, prDir);
    const [host, owner, repo, number] = rel.split(path.sep);
    const key = `${host}/${owner}/${repo}/${number}`;
    const events = readEvents(path.join(prDir, "events.jsonl"));
    events.forEach((e, i) => {
      if (e.type !== "analysis-finished") return;
      const m = e.metrics;
      if (!m) return; // a reconciled "server restarted" or pre-metrics run: nothing to show
      const run = m.run ?? {};
      const size = run.size ?? sizeFromFiles(prDir, e.revision);
      const lines = size ? size.added + size.removed : undefined;
      const cliMinutes = m.durationMs !== undefined ? m.durationMs / 60_000 : undefined;
      const wallMinutes = run.wallMs !== undefined ? run.wallMs / 60_000 : undefined;
      const minutes = wallMinutes ?? cliMinutes;
      const stalled =
        wallMinutes !== undefined && cliMinutes !== undefined && wallMinutes > cliMinutes * 1.5 && wallMinutes - cliMinutes >= 2;
      const per100 = (v) => (v !== undefined && lines ? (v * 100) / lines : undefined);
      rows.push({
        key,
        repo: `${host}/${owner}/${repo}`,
        revision: e.revision,
        finishedAt: e.ts,
        status: e.status,
        kind: run.kind,
        model: run.resolvedModel ?? run.model,
        effort: run.effort,
        promptVersion: run.promptVersion,
        claudeVersion: run.claudeVersion,
        size,
        migration: run.migration,
        minutes,
        minutesSource: wallMinutes !== undefined ? "wall" : cliMinutes !== undefined ? "durationMs" : undefined,
        cliMinutes,
        stalled,
        turns: m.turns,
        cost: m.costUsd,
        cacheRead: m.usage?.cacheRead,
        minPer100: per100(minutes),
        costPer100: per100(m.costUsd),
        readsFiles: (m.reads?.filesJson ?? 0) + (m.bash?.state ?? 0),
        bashGrepSed: (m.bash?.grep ?? 0) + (m.bash?.sed ?? 0),
        phases: m.phases,
        sessionId: run.sessionId,
        transcript: transcriptPath(run),
        ...outcomesAfter(events, i),
      });
    });
  }
  return rows.sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt)));
}

function filterRuns(rows, opts) {
  const since = opts.since !== undefined ? Date.parse(opts.since) : undefined;
  const until = opts.until !== undefined ? Date.parse(opts.until) : undefined;
  return rows.filter((r) => {
    if (opts.kind !== undefined && r.kind !== opts.kind) return false;
    if (opts.status !== undefined && r.status !== opts.status) return false;
    if (opts.pr !== undefined && !r.key.includes(opts.pr)) return false;
    if (opts.prompt !== undefined && !(r.promptVersion ?? "").startsWith(opts.prompt)) return false;
    const t = Date.parse(r.finishedAt);
    if (since !== undefined && !(t >= since)) return false;
    if (until !== undefined && !(t <= until)) return false;
    return true;
  });
}

/* ---------------------------------------------------------------- format */

const dash = "-";
const fmt = {
  num: (v, digits = 1) => (v !== undefined ? v.toFixed(digits) : dash),
  int: (v) => (v !== undefined ? String(v) : dash),
  usd: (v) => (v !== undefined ? `$${v.toFixed(2)}` : dash),
  str: (v) => v ?? dash,
};

function fmtPhase(phases) {
  if (!phases) return dash;
  const { firstInvestigationAt, firstWriteAt, setAnalysisAt } = phases;
  return (
    [
      firstInvestigationAt !== undefined ? `inv@${firstInvestigationAt}` : null,
      firstWriteAt !== undefined ? `write@${firstWriteAt}` : null,
      setAnalysisAt !== undefined ? `set@${setAnalysisAt}` : null,
    ]
      .filter(Boolean)
      .join(" ") || dash
  );
}

function fmtSize(size) {
  return size ? `${size.files}f/${size.hunks}h/+${size.added}-${size.removed}` : dash;
}

function fmtMigration(mig) {
  return mig
    ? `=${mig.identical} ~${mig.fuzzy} r${mig.renamed} x${mig.archived} +${mig.new} cu${mig.changedUnits}`
    : dash;
}

function printTable(headers, cells) {
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const printRow = (cols) => console.log(cols.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd());
  printRow(headers);
  printRow(widths.map((w) => "-".repeat(w)));
  for (const row of cells) printRow(row);
}

function printRuns(rows, opts) {
  const headers = [
    "#",
    "key",
    "rev",
    "finished",
    "status",
    "kind",
    "model",
    "effort",
    "prompt",
    "size",
    "mig",
    "minutes",
    "cli.min",
    "gap",
    "turns",
    "cost",
    "min/100L",
    "$/100L",
    "cacheRead",
    "triage.reads",
    "bash.grep+sed",
    "phases",
    "corr",
    "edits",
  ];
  const cells = rows.map((r, i) => [
    String(i + 1),
    r.key,
    String(r.revision),
    String(r.finishedAt ?? dash).slice(0, 16).replace("T", " "),
    r.status,
    fmt.str(r.kind),
    fmt.str(r.model),
    fmt.str(r.effort),
    fmt.str(r.promptVersion?.slice(0, 7)),
    fmtSize(r.size),
    fmtMigration(r.migration),
    fmt.num(r.minutes) + (r.minutesSource === "durationMs" ? "~" : ""),
    fmt.num(r.cliMinutes),
    r.stalled ? "!" : "",
    fmt.int(r.turns),
    fmt.usd(r.cost),
    fmt.num(r.minPer100, 2),
    fmt.usd(r.costPer100),
    fmt.int(r.cacheRead),
    String(r.readsFiles),
    String(r.bashGrepSed),
    fmtPhase(r.phases),
    String(r.corrections),
    String(r.edits),
  ]);
  printTable(headers, cells);

  if (opts.transcripts) {
    const known = rows.map((r, i) => [i + 1, r.transcript]).filter(([, t]) => t);
    console.log("");
    if (known.length === 0) console.log("no run recorded a session id + cwd");
    for (const [n, t] of known) console.log(`#${n}  ${t}${fs.existsSync(t) ? "" : "  (missing)"}`);
  }
}

const groupKey = {
  kind: (r) => r.kind,
  model: (r) => r.model,
  effort: (r) => r.effort,
  prompt: (r) => r.promptVersion,
  repo: (r) => r.repo,
  status: (r) => r.status,
};

function mean(values) {
  const vs = values.filter((v) => v !== undefined);
  return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : undefined;
}

function median(values) {
  const vs = values.filter((v) => v !== undefined).sort((a, b) => a - b);
  if (!vs.length) return undefined;
  const mid = Math.floor(vs.length / 2);
  return vs.length % 2 ? vs[mid] : (vs[mid - 1] + vs[mid]) / 2;
}

function groupRuns(rows, by) {
  const groups = new Map();
  for (const r of rows) {
    const k = groupKey[by](r) ?? dash;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.entries()]
    .map(([value, rs]) => ({
      value,
      runs: rs.length,
      medianMinutes: median(rs.map((r) => r.minutes)),
      meanMinutes: mean(rs.map((r) => r.minutes)),
      meanCost: mean(rs.map((r) => r.cost)),
      totalCost: rs.reduce((a, r) => a + (r.cost ?? 0), 0),
      meanTurns: mean(rs.map((r) => r.turns)),
      minPer100: mean(rs.map((r) => r.minPer100)),
      costPer100: mean(rs.map((r) => r.costPer100)),
      meanCorrections: mean(rs.map((r) => r.corrections)),
      meanEdits: mean(rs.map((r) => r.edits)),
    }))
    .sort((a, b) => b.runs - a.runs);
}

function printGroups(groups, by) {
  const headers = [by, "runs", "med.min", "avg.min", "avg.cost", "total.cost", "avg.turns", "min/100L", "$/100L", "avg.corr", "avg.edits"];
  const cells = groups.map((g) => [
    String(g.value),
    String(g.runs),
    fmt.num(g.medianMinutes),
    fmt.num(g.meanMinutes),
    fmt.usd(g.meanCost),
    fmt.usd(g.totalCost),
    fmt.num(g.meanTurns),
    fmt.num(g.minPer100, 2),
    fmt.usd(g.costPer100),
    fmt.num(g.meanCorrections, 2),
    fmt.num(g.meanEdits, 2),
  ]);
  printTable(headers, cells);
}

/* ------------------------------------------------------------------ main */

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  const header = fs.readFileSync(new URL(import.meta.url), "utf8").split("\nimport ")[0];
  console.log(header.replace(/^#!.*\n/, "").replace(/^\/\/ ?/gm, ""));
  process.exit(0);
}

const root =
  process.env.PURVIEW_STATE_DIR ||
  process.env.REVIEWER_STATE_DIR ||
  path.join(os.homedir(), ".purview");

if (!fs.existsSync(root)) {
  console.error(`no state dir at ${root}`);
  process.exit(1);
}

const rows = filterRuns(collectRuns(root), opts);

if (opts.json) {
  const out = opts.group ? groupRuns(rows, opts.group) : rows;
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

if (rows.length === 0) {
  console.log(`no matching metrics-bearing analysis runs under ${root}`);
  process.exit(0);
}

if (opts.group) printGroups(groupRuns(rows, opts.group), opts.group);
else printRuns(rows, opts);
