#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  parseKey,
  parsePrUrl,
  prCheckoutPath,
  prDir,
  keyToString,
  type PrKey,
} from "./paths.js";
import {
  discardRevision,
  initPr,
  refreshPr,
  setAnalysis,
  setHunkViewed,
  setUnit,
  setUnitViewed,
  syncPr,
  truncateFindings,
} from "./service.js";
import { loadState, prExists, readFilesJson, readMigrationReport, listPrs } from "./store.js";
import { migrateStateDirOnStartup } from "./state-dir.js";
import { formatReport } from "./report.js";
import { renderTriage } from "./triage.js";
import { allSelectedHunks, renderShowHunk, selectHunks } from "./hunk-select.js";
import { renderChanges } from "./changes.js";

// The state dir was renamed `~/.reviewer` -> `~/.purview`; whichever entry
// point runs first does the one-time move. Logged on stderr so `--json` output
// stays machine-readable.
migrateStateDirOnStartup({
  info: (s) => console.error(s),
  warn: (s) => console.error(s),
});

/** This CLI's own real invocation, for the triage view's `bodies:` line. */
function selfCliCommand(): string {
  return `${process.execPath} ${process.argv[1]}`;
}

function resolveRevision(state: { currentRevision: number }, rev?: string): number {
  if (rev === undefined) return state.currentRevision;
  const n = Number(rev);
  if (!Number.isInteger(n)) throw new Error(`Invalid --rev "${rev}"`);
  return n;
}

/**
 * Above this, Claude Code does not show a Bash result inline: it saves it to
 * a file and hands the model a pointer, which costs a turn to discover and
 * another to read. (Its threshold is fixed; BASH_MAX_OUTPUT_LENGTH does not
 * move it.) `show` writes big results to the PR's scratch dir itself and
 * prints the path, so the model goes straight to one Read.
 */
export const SHOW_INLINE_LIMIT = 25_000;

/**
 * Print `body`, or — above SHOW_INLINE_LIMIT, unless `inline` — write it to
 * the PR's scratch dir and print `summary` plus the path to Read instead.
 */
function printOrSpill(
  key: PrKey,
  body: string,
  opts: { summary: string; name: string; inline?: boolean },
): void {
  if (opts.inline || body.length <= SHOW_INLINE_LIMIT) {
    process.stdout.write(body);
    return;
  }
  const dir = path.join(prDir(key), "scratch");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${opts.name}-${Date.now()}.txt`);
  fs.writeFileSync(file, body, "utf8");
  console.log(`${opts.summary}, ${Math.round(body.length / 1024)} KB: too large to print inline.`);
  console.log(`Written to ${file}`);
  console.log("Read that file with the Read tool (page with offset/limit if it is very long).");
  console.log("Cite source lines from its gutter (old new │), never the file's own line numbers.");
}

function readJsonFile(file: string): unknown {
  if (file === "-") return JSON.parse(fs.readFileSync(0, "utf8"));
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Parse a key and refuse to touch a PR that was never initialized.
 * `loadState` happily folds an empty event log into a revision-0 state, so
 * without this a typo'd key would silently create a bogus state directory
 * instead of reporting the mistake.
 */
function requireExistingKey(keyArg: string): PrKey {
  const key = parseKey(keyArg);
  if (!prExists(key)) {
    throw new Error(
      `No local state for ${keyToString(key)}. ` +
        `Run \`reviewer-state init <pr-url>\` first (\`reviewer-state list\` shows tracked PRs).`,
    );
  }
  return key;
}

const program = new Command();
program
  .name("reviewer-state")
  .description("Local PR review state: init, refresh, report, view, sync")
  .version("0.1.0");

program
  .command("init")
  .argument("<pr-url>", "https://github.com/owner/repo/pull/123")
  .description("fetch PR meta + diff via gh and create local state")
  .action((url: string) => {
    const key = parsePrUrl(url);
    const res = initPr(key);
    console.log(
      `${res.created ? "Initialized" : "Already initialized"} ${keyToString(key)}`,
    );
    console.log(`State dir: ${prDir(key)}`);
    console.log(`Current revision: ${res.revision}`);
    console.log(
      `${res.state.files.length} files, ${Object.keys(res.state.hunks).length} hunks`,
    );
  });

program
  .command("refresh")
  .argument("<key>", "host/owner/repo/number or a PR URL")
  .description("fetch the latest diff and migrate state onto it")
  .action((keyArg: string) => {
    const key = requireExistingKey(keyArg);
    const res = refreshPr(key);
    if (!res.added) {
      console.log(`No change; still at revision ${res.revision}.`);
      return;
    }
    console.log(
      `Added revision ${res.revision}${res.baseOnly ? " (base moved only)" : ""}.`,
    );
    console.log("");
    console.log(formatReport(res.state, res.report));
  });

program
  .command("discard-revision")
  .argument("<key>")
  .argument("<revision>", "the current revision's number, spelled out as a safety check")
  .description(
    "drop the latest revision (e.g. one fetched mid-rebase); the next refresh diffs against the one before it",
  )
  .action((keyArg: string, revArg: string) => {
    const key = requireExistingKey(keyArg);
    const revision = Number(revArg);
    if (!Number.isInteger(revision)) throw new Error(`Invalid revision "${revArg}"`);
    const res = discardRevision(key, revision);
    console.log(`Discarded revision ${res.discarded}; back at revision ${res.revision}.`);
    console.log(
      `Revision ${res.discarded}'s number is not reused: the next refresh adds revision ` +
        `${res.discarded + 1}, migrated from revision ${res.revision}.`,
    );
  });

program
  .command("report")
  .argument("<key>")
  .option("--json", "print state.json instead of the human report")
  .description("print migration report and per-unit progress")
  .action((keyArg: string, opts: { json?: boolean }) => {
    const key = requireExistingKey(keyArg);
    const state = loadState(key);
    if (opts.json) {
      console.log(JSON.stringify(state, null, 2));
      return;
    }
    console.log(
      formatReport(state, readMigrationReport(key, state.currentRevision)),
    );
  });

program
  .command("triage")
  .argument("<key>")
  .option("--rev <n>", "revision to render (defaults to the current one)")
  .description("one-turn overview of a revision's files/hunks (path, hunk ids, headers, sizes, hints)")
  .action((keyArg: string, opts: { rev?: string }) => {
    const key = requireExistingKey(keyArg);
    const state = loadState(key);
    const revision = resolveRevision(state, opts.rev);
    const filesJson = readFilesJson(key, revision);
    process.stdout.write(
      renderTriage(filesJson, { cliCommand: selfCliCommand(), key: keyToString(key) }),
    );
  });

program
  .command("show")
  .argument("<key>")
  .argument("[selectors...]", "hunk id (exact or unique prefix >=6 chars), file path, or glob")
  .option("--rev <n>", "revision to read from (defaults to the current one)")
  .option("--all", "print every hunk of the revision, ignoring selectors")
  .option("--inline", "always print to stdout, even when the result is large")
  .description("print full hunk bodies for the given selectors (large results go to a scratch file)")
  .action((keyArg: string, selectors: string[], opts: { rev?: string; all?: boolean; inline?: boolean }) => {
    const key = requireExistingKey(keyArg);
    const state = loadState(key);
    const revision = resolveRevision(state, opts.rev);
    const filesJson = readFilesJson(key, revision);

    if (!opts.all && selectors.length === 0) {
      throw new Error("Pass at least one selector, or --all to print every hunk.");
    }

    const { hunks, unknown } = opts.all
      ? { hunks: allSelectedHunks(filesJson), unknown: [] as string[] }
      : selectHunks(filesJson, selectors);

    const files = new Set(hunks.map((sh) => sh.file.path));
    const summary = `-- ${hunks.length} hunks, ${files.size} files`;
    const body = hunks.map(renderShowHunk).join("") + summary + "\n";

    printOrSpill(key, body, { summary, name: "show", inline: opts.inline });

    if (unknown.length > 0) {
      console.error(`error: unknown selector(s): ${unknown.join(", ")}`);
      process.exitCode = 1;
    }
  });

program
  .command("changes")
  .argument("<key>")
  .option("--rev <n>", "revision whose migration to read (defaults to the current one)")
  .option("--inline", "always print to stdout, even when the result is large")
  .description(
    "units a revision reworked (fuzzy/renamed/archived hunks): current description plus a compact before->after",
  )
  .action((keyArg: string, opts: { rev?: string; inline?: boolean }) => {
    const key = requireExistingKey(keyArg);
    const state = loadState(key);
    const revision = resolveRevision(state, opts.rev);
    const report = readMigrationReport(key, revision);
    const filesOf = (rev: number | undefined) => {
      if (rev === undefined) return undefined;
      try {
        return readFilesJson(key, rev).files;
      } catch {
        return undefined;
      }
    };
    const { body, summary } = renderChanges({
      state,
      report,
      revision,
      previousFiles: filesOf(report?.previousRevision),
      currentFiles: filesOf(revision),
    });
    printOrSpill(key, body, { summary, name: "changes", inline: opts.inline });
  });

/** Exit with a message on stderr (no `error:` prefix — the text is the answer). */
class CliExit extends Error {
  constructor(
    message: string,
    readonly code = 1,
  ) {
    super(message);
  }
}

function gitIn(dir: string, args: string[]): Buffer {
  return execFileSync("git", ["-C", dir, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

function gitOk(dir: string, args: string[]): boolean {
  try {
    gitIn(dir, args);
    return true;
  } catch {
    return false;
  }
}

program
  .command("base-file")
  .argument("<key>")
  .argument("<path>", "file path (the PR's new path or, for a rename, the old one)")
  .option("--rev <n>", "revision whose base to read (defaults to the current one)")
  .description("print a file as it was before the PR (at the revision's merge base)")
  .action((keyArg: string, filePath: string, opts: { rev?: string }) => {
    const key = requireExistingKey(keyArg);
    const state = loadState(key);
    const revision = resolveRevision(state, opts.rev);
    const info = state.revisions.find((r) => r.revision === revision);
    let files: ReturnType<typeof readFilesJson> | undefined;
    try {
      files = readFilesJson(key, revision);
    } catch {
      files = undefined;
    }
    const baseSha = info?.mergeBase || info?.baseSha || files?.mergeBase || files?.baseSha;
    if (!baseSha) throw new Error(`Revision ${revision} of ${keyToString(key)} has no base commit recorded.`);

    const dir = prCheckoutPath(key);
    if (!fs.existsSync(dir)) {
      throw new Error(
        `No managed checkout for ${keyToString(key)} at ${dir}. It is created when an analysis ` +
          "or chat runs with a configured local repository (and managedCheckouts on).",
      );
    }
    if (!gitOk(dir, ["cat-file", "-e", `${baseSha}^{commit}`])) {
      throw new Error(`Base commit ${baseSha.slice(0, 12)} is not available in ${dir}.`);
    }

    // A renamed file is asked for by its new path most of the time; at base
    // it lived at its old path.
    const cleaned = filePath.replace(/^\.\//, "");
    const renamed = files?.files.find((f) => f.path === cleaned && f.oldPath && f.oldPath !== f.path);
    const basePath = renamed?.oldPath ?? cleaned;

    if (!gitOk(dir, ["cat-file", "-e", `${baseSha}:${basePath}`])) {
      throw new CliExit(`${basePath}: not present at base (added by this PR)`);
    }
    process.stdout.write(gitIn(dir, ["show", `${baseSha}:${basePath}`]));
  });

program
  .command("set-analysis")
  .argument("<key>")
  .requiredOption("--file <json>", 'JSON file with {summary, units} ("-" for stdin)')
  .description("replace the analysis for the current revision")
  .action((keyArg: string, opts: { file: string }) => {
    const key = requireExistingKey(keyArg);
    const { payload, warnings } = truncateFindings(readJsonFile(opts.file));
    const { state, coverage } = setAnalysis(key, payload);
    for (const w of warnings) console.log(w);
    console.log(
      `Analysis set for revision ${state.currentRevision}: ` +
        `${state.units.length} units covering ${coverage.covered.length} hunks` +
        (state.unassignedHunkIds.length > 0
          ? `, ${state.unassignedHunkIds.length} explicitly unassigned`
          : ""),
    );
  });

program
  .command("set-unit")
  .argument("<key>")
  .requiredOption("--file <json>", 'JSON file with a unit or a partial patch ("-" for stdin)')
  .option("--id <unitId>", "unit id (required when the JSON has no id)")
  .option("--note <text>", "note recorded with any classification correction")
  .description("create or patch a single review unit")
  .action((keyArg: string, opts: { file: string; id?: string; note?: string }) => {
    const key = requireExistingKey(keyArg);
    const raw = readJsonFile(opts.file) as Record<string, unknown>;
    const unitId = opts.id ?? (raw.id as string | undefined);
    if (!unitId)
      throw new Error("Unit id missing: pass --id or include `id` in the JSON");
    // setUnit validates strictly against the full schema for a brand-new
    // unit id, and as a partial patch when the unit id already exists.
    const { payload, warnings } = truncateFindings(raw, unitId);
    const state = setUnit(key, unitId, payload, { note: opts.note });
    for (const w of warnings) console.log(w);
    const unit = state.units.find((u) => u.id === unitId)!;
    console.log(
      `Unit ${unit.id} saved: [${unit.attention}/${unit.kind}] ${unit.title} ` +
        `(${unit.hunkIds.length} hunks)`,
    );
  });

program
  .command("view")
  .argument("<key>")
  .argument("<target>", "hunk id, or unit:<unitId>")
  .option("--unview", "mark as not viewed instead")
  .description("mark a hunk or a whole unit viewed")
  .action((keyArg: string, target: string, opts: { unview?: boolean }) => {
    const key = requireExistingKey(keyArg);
    const viewed = !opts.unview;
    if (target.startsWith("unit:")) {
      const unitId = target.slice("unit:".length);
      const state = setUnitViewed(key, unitId, viewed);
      const unit = state.units.find((u) => u.id === unitId)!;
      console.log(
        `Unit ${unitId}: ${unit.hunkIds.length} hunks marked ${viewed ? "viewed" : "unviewed"}.`,
      );
    } else {
      const before = loadState(key);
      if (!before.hunks[target]) {
        throw new Error(
          `Hunk ${target} is not part of revision ${before.currentRevision}; ` +
            `nothing was recorded.`,
        );
      }
      setHunkViewed(key, target, viewed);
      console.log(`Hunk ${target} marked ${viewed ? "viewed" : "unviewed"}.`);
    }
    const state = loadState(key);
    const done = Object.values(state.hunks).filter((h) => h.viewed).length;
    console.log(`${done}/${Object.keys(state.hunks).length} hunks viewed.`);
  });

program
  .command("sync")
  .argument("<key>")
  .description("push the viewed-file projection to GitHub")
  .action((keyArg: string) => {
    const key = requireExistingKey(keyArg);
    const res = syncPr(key);
    if (res.pushed.length === 0) console.log("Nothing to push; GitHub is up to date.");
    for (const p of res.pushed) {
      console.log(`${p.viewed ? "viewed  " : "unviewed"} ${p.file}`);
    }
    if (res.drift.length > 0) {
      console.log("");
      console.log("Drift detected (local wins, nothing was overwritten locally):");
      for (const d of res.drift) {
        console.log(`  ${d.file}: local=${d.local ? "viewed" : "unviewed"} remote=${d.remote}`);
      }
    }
  });

program
  .command("list")
  .description("list PRs with local state")
  .action(() => {
    const prs = listPrs();
    if (prs.length === 0) console.log("No PRs tracked yet.");
    for (const key of prs) {
      const state = loadState(key);
      const total = Object.keys(state.hunks).length;
      const viewed = Object.values(state.hunks).filter((h) => h.viewed).length;
      console.log(
        `${keyToString(key)}  r${state.currentRevision}  ${viewed}/${total} hunks` +
          (state.pr?.title ? `  ${state.pr.title}` : ""),
      );
    }
  });

try {
  program.parse(process.argv);
} catch (err) {
  if (err instanceof CliExit) {
    console.error(err.message);
    process.exit(err.code);
  }
  console.error(`error: ${(err as Error).message}`);
  process.exit(1);
}
