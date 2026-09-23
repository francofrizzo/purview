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
  setUnits,
  setUnitViewed,
  remainingWorkFor,
  syncPr,
  truncateFindings,
} from "./service.js";
import { loadState, prExists, readFilesJson, readMigrationReport, listPrs } from "./store.js";
import { migrateStateDirOnStartup } from "./state-dir.js";
import { formatReport } from "./report.js";
import { renderTriage } from "./triage.js";
import { allSelectedHunks, renderShowHunk, selectHunks } from "./hunk-select.js";
import { renderChanges } from "./changes.js";
import { formatRemaining, needsClassification, renderUnits, type UnitPatchRequest } from "./unit-patch.js";
import {
  callServer,
  commentLocation,
  commentsUrl,
  formatCommentList,
  newCommentPayload,
  resolveBody,
  serverBaseUrl,
  type ServerComment,
} from "./comment-client.js";

// The state dir was renamed `~/.reviewer` -> `~/.purview`; whichever entry
// point runs first does the one-time move. Logged on stderr so `--json` output
// stays machine-readable.
migrateStateDirOnStartup({
  info: (s) => console.error(s),
  warn: (s) => console.error(s),
});

/**
 * This CLI's own real invocation, for the lines that tell the reader how to
 * fetch more (`bodies:`, "… `show <id>` for all"). The server's wrapper
 * script exports its own path as PURVIEW_CLI_SELF, so a run sees the single
 * executable path it was told to use rather than `<node> <cli.js>`.
 */
function selfCliCommand(): string {
  return process.env.PURVIEW_CLI_SELF || `${process.execPath} ${process.argv[1]}`;
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
  opts: { summary: string; name: string; inline?: boolean; toc?: string[] },
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
  if (opts.toc && opts.toc.length > 0) {
    console.log("Contents (line ranges in that file; Read just the parts you need with offset=<first line> limit=<count>):");
    for (const line of opts.toc) console.log(`  ${line}`);
  } else {
    console.log("Read that file with the Read tool (page with offset/limit if it is very long).");
  }
  console.log("Cite source lines from its gutter (old new │), never the file's own line numbers.");
}

/** `L<from>-<to>` plus the line count, as a table-of-contents cell. */
function range(from: number, to: number): string {
  return `L${from}-${to} (${to - from + 1} lines)`;
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
  .argument(
    "[selectors...]",
    "hunk id (exact or unique prefix >=6 chars), file path, glob, or unit:<unitId> (that unit's hunks)",
  )
  .option("--rev <n>", "revision to read from (defaults to the current one)")
  .option("--all", "print every hunk of the revision, ignoring selectors")
  .option("--needs", "add every hunk that still needs classification (in no unit, not explicitly unassigned)")
  .option("--inline", "always print to stdout, even when the result is large")
  .description("print full hunk bodies for the given selectors (large results go to a scratch file)")
  .action(
    (
      keyArg: string,
      selectors: string[],
      opts: { rev?: string; all?: boolean; inline?: boolean; needs?: boolean },
    ) => {
    const key = requireExistingKey(keyArg);
    const state = loadState(key);
    const revision = resolveRevision(state, opts.rev);
    const filesJson = readFilesJson(key, revision);

    if (!opts.all && !opts.needs && selectors.length === 0) {
      throw new Error("Pass at least one selector, --needs, or --all to print every hunk.");
    }
    if ((opts.needs || selectors.some((s) => s.startsWith("unit:"))) && revision !== state.currentRevision) {
      throw new Error("--needs and unit:<id> read the current revision's state; drop --rev.");
    }

    // unit:<id> and --needs expand to plain hunk ids before selection.
    const unknownUnits: string[] = [];
    const expanded = selectors.flatMap((sel) => {
      if (!sel.startsWith("unit:")) return [sel];
      const unit = state.units.find((u) => u.id === sel.slice("unit:".length));
      if (!unit) {
        unknownUnits.push(sel);
        return [];
      }
      return unit.hunkIds;
    });
    if (opts.needs) expanded.push(...needsClassification(state).map((h) => h.id));

    const { hunks, unknown } = opts.all
      ? { hunks: allSelectedHunks(filesJson), unknown: [] as string[] }
      : selectHunks(filesJson, expanded);
    unknown.push(...unknownUnits);

    const files = new Set(hunks.map((sh) => sh.file.path));
    const summary =
      hunks.length === 0 && opts.needs && expanded.length === 0
        ? "-- 0 hunks: nothing needs classification"
        : `-- ${hunks.length} hunks, ${files.size} files`;
    // The body and a per-file table of contents (1-based line ranges), so a
    // spilled result can be Read in pieces instead of paged blindly.
    const toc: string[] = [];
    let body = "";
    let line = 1;
    let group: { path: string; from: number; ids: string[] } | undefined;
    const closeGroup = () => {
      if (group) toc.push(`${range(group.from, line - 1)}  ${group.path}  ${group.ids.join(" ")}`);
    };
    for (const sh of hunks) {
      if (group?.path !== sh.file.path) {
        closeGroup();
        group = { path: sh.file.path, from: line, ids: [] };
      }
      const text = renderShowHunk(sh);
      group.ids.push(`${sh.hunk.id.slice(0, 8)}@L${line}`);
      body += text;
      line += text.split("\n").length - 1;
    }
    closeGroup();
    body += summary + "\n";

    printOrSpill(key, body, { summary, name: "show", inline: opts.inline, toc });

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
    const { body, summary, toc } = renderChanges({
      state,
      report,
      revision,
      previousFiles: filesOf(report?.previousRevision),
      currentFiles: filesOf(revision),
      showCommand: `${selfCliCommand()} show ${keyToString(key)}`,
    });
    printOrSpill(key, body, {
      summary,
      name: "changes",
      inline: opts.inline,
      toc: toc.map((t) => `${range(t.from, t.to)}  ${t.label}`),
    });
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
    console.log(formatRemaining(remainingWorkFor(key)));
  });

program
  .command("set-unit")
  .argument("<key>")
  .requiredOption("--file <json>", 'JSON file with a unit or a partial patch ("-" for stdin)')
  .option("--id <unitId>", "unit id (required when the JSON has no id)")
  .option("--note <text>", "note recorded with any classification correction")
  .description(
    "create or patch a single review unit (hunkIds replaces the list; addHunkIds/removeHunkIds edit it)",
  )
  .action((keyArg: string, opts: { file: string; id?: string; note?: string }) => {
    const key = requireExistingKey(keyArg);
    const raw = readJsonFile(opts.file) as Record<string, unknown>;
    const unitId = opts.id ?? (raw.id as string | undefined);
    if (!unitId)
      throw new Error("Unit id missing: pass --id or include `id` in the JSON");
    // setUnit validates strictly against the full schema for a brand-new
    // unit id, and as a partial patch when the unit id already exists.
    const { payload, warnings } = truncateFindings(raw, unitId);
    const res = setUnits(key, [{ unitId, payload, note: opts.note ?? (raw.note as string | undefined) }]);
    for (const w of [...warnings, ...res.warnings]) console.log(w);
    const unit = res.state.units.find((u) => u.id === unitId)!;
    console.log(
      `Unit ${unit.id} saved: [${unit.attention}/${unit.kind}] ${unit.title} ` +
        `(${unit.hunkIds.length} hunks)`,
    );
    console.log(formatRemaining(remainingWorkFor(key)));
  });

program
  .command("set-units")
  .argument("<key>")
  .requiredOption("--file <json>", 'JSON file with {"units": [{"id": ..., ...patch}]}')
  .description(
    "create or patch several units in one all-or-nothing batch (each entry like set-unit's JSON, plus an optional `note`)",
  )
  .action((keyArg: string, opts: { file: string }) => {
    const key = requireExistingKey(keyArg);
    const raw = readJsonFile(opts.file) as { units?: unknown };
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.units)) {
      throw new Error('Expected {"units": [ {"id": "<unitId>", ...patch}, ... ]}');
    }
    const warnings: string[] = [];
    const requests: UnitPatchRequest[] = raw.units.map((entry, i) => {
      const e = (entry ?? {}) as Record<string, unknown>;
      if (typeof e.id !== "string" || !e.id) throw new Error(`units[${i}] has no "id"; nothing was written`);
      const fixed = truncateFindings(e, e.id);
      warnings.push(...fixed.warnings);
      return { unitId: e.id, payload: fixed.payload, note: typeof e.note === "string" ? e.note : undefined };
    });
    if (requests.length === 0) throw new Error('"units" is empty; nothing to write');
    const res = setUnits(key, requests);
    for (const w of [...warnings, ...res.warnings]) console.log(w);
    for (const id of res.unitIds) {
      const unit = res.state.units.find((u) => u.id === id)!;
      console.log(`Unit ${unit.id} saved: [${unit.attention}/${unit.kind}] ${unit.title} (${unit.hunkIds.length} hunks)`);
    }
    console.log(formatRemaining(remainingWorkFor(key)));
  });

program
  .command("units")
  .argument("<key>")
  .argument("[unitIds...]", "only these units (default: all)")
  .description("compact unit listing: id, attention/kind, title, hunk ids by file (short ids), findings; husks marked ~")
  .action((keyArg: string, unitIds: string[]) => {
    const key = requireExistingKey(keyArg);
    const state = loadState(key);
    const { text, unknown } = renderUnits(state, unitIds);
    process.stdout.write(text);
    if (unknown.length > 0) {
      console.error(`error: unknown unit(s): ${unknown.join(", ")}`);
      process.exitCode = 1;
    }
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

/*
 * Draft comments. Unlike every command above, these do not touch the state
 * directory: comments.json belongs to the running server, so they go through
 * its HTTP API on loopback (see comment-client.ts). Inside the review chat
 * (PURVIEW_ACTOR=chat) the server records them as Claude's and refuses to
 * touch anything that is not a draft.
 */
const comment = program
  .command("comment")
  .description("create, edit, delete or list draft review comments (through the running server)");

function readBodyFile(file: string): string {
  return fs.readFileSync(file === "-" ? 0 : file, "utf8");
}

async function findComment(key: PrKey, id: string): Promise<ServerComment> {
  const { comments } = await callServer<{ comments: ServerComment[] }>(
    "GET",
    commentsUrl(serverBaseUrl(), key),
  );
  const found = comments.find((c) => c.id === id);
  if (!found) {
    throw new Error(
      `No comment ${id} on ${keyToString(key)}. \`reviewer-state comment list ${keyToString(key)}\` shows the ids.`,
    );
  }
  return found;
}

comment
  .command("list")
  .argument("<key>")
  .description("list the PR's comments: id, status, author, location, first line")
  .action(async (keyArg: string) => {
    const key = parseKey(keyArg);
    const { comments } = await callServer<{ comments: ServerComment[] }>(
      "GET",
      commentsUrl(serverBaseUrl(), key),
    );
    process.stdout.write(formatCommentList(comments));
  });

comment
  .command("add")
  .argument("<key>")
  .requiredOption("--file <path>", "file path as it appears in the diff")
  .option("--line <n>", "line number on --side (new side by default)")
  .option("--side <RIGHT|LEFT>", "RIGHT = the new version (default), LEFT = the old one")
  .option("--whole-file", "comment on the file as a whole instead of a line")
  .option("--body <text>", "the comment text (single-quote it)")
  .option("--body-file <path>", 'file with the comment text ("-" for stdin)')
  .description("create a draft comment; prints its id")
  .action(
    async (
      keyArg: string,
      opts: { file: string; line?: string; side?: string; wholeFile?: boolean; body?: string; bodyFile?: string },
    ) => {
      const key = parseKey(keyArg);
      const payload = { ...newCommentPayload(opts), body: resolveBody(opts, readBodyFile) };
      const { comment: created } = await callServer<{ comment: ServerComment }>(
        "POST",
        commentsUrl(serverBaseUrl(), key),
        payload,
      );
      console.log(`Created draft comment ${created.id} at ${commentLocation(created)}.`);
    },
  );

comment
  .command("edit")
  .argument("<key>")
  .argument("<commentId>")
  .option("--body <text>", "the new comment text (single-quote it)")
  .option("--body-file <path>", 'file with the new text ("-" for stdin)')
  .description("replace a draft comment's text (the previous text stays undoable)")
  .action(async (keyArg: string, id: string, opts: { body?: string; bodyFile?: string }) => {
    const key = parseKey(keyArg);
    const body = resolveBody(opts, readBodyFile);
    const target = await findComment(key, id);
    const res = await callServer<{ comment: ServerComment; remote?: { ok: boolean; reason?: string } | null }>(
      "PATCH",
      commentsUrl(serverBaseUrl(), key, `/${encodeURIComponent(id)}`),
      { body },
    );
    console.log(`Edited ${target.status} comment ${res.comment.id} at ${commentLocation(res.comment)}.`);
    if (res.remote && !res.remote.ok) console.log(`GitHub was not updated: ${res.remote.reason ?? "unknown error"}`);
  });

comment
  .command("delete")
  .argument("<key>")
  .argument("<commentId>")
  .description("delete a comment (a deleted draft stays restorable from Purview for a day)")
  .action(async (keyArg: string, id: string) => {
    const key = parseKey(keyArg);
    const target = await findComment(key, id);
    const res = await callServer<{ trashed?: boolean }>(
      "DELETE",
      commentsUrl(serverBaseUrl(), key, `/${encodeURIComponent(id)}`),
    );
    console.log(
      `Deleted ${target.status} comment ${id} at ${commentLocation(target)}` +
        (res.trashed ? "; it can be restored from Purview's comments panel." : "."),
    );
  });

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof CliExit) {
    console.error(err.message);
    process.exit(err.code);
  }
  console.error(`error: ${(err as Error).message}`);
  process.exit(1);
}
