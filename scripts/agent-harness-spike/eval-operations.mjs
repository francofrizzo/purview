import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import * as core from "../../packages/core/dist/index.js";
import { createApp } from "../../packages/server/dist/app.js";
import { readComments } from "../../packages/server/dist/comments.js";

// Experimental operation boundary for the eval, not registered in the product.
// State mutations use real services; comments retain the HTTP route's existing
// anchoring, attachment, audience, history and trash validation via app.request.
const pageArgs = { cursor: z.string().optional(), limit: z.number().int().min(1).max(100).default(40) };
const relativePath = z.string().min(1).max(512);
const revisionArg = z.number().int().positive().optional();
const commentInput = {
  file: relativePath, line: z.number().int().positive().optional(),
  subjectType: z.enum(["line", "file"]).optional(),
  side: z.enum(["LEFT", "RIGHT"]).default("RIGHT"), startLine: z.number().int().positive().optional(),
  body: z.string().min(1).max(20000), audience: z.enum(["github", "agent"]).optional(),
};
const analysisInput = core.AnalysisSchema;
const patchInput = z.array(z.object({ id: z.string().min(1), patch: z.record(z.string(), z.unknown()) }).strict()).min(1).max(100);

function failure(code, message) { throw Object.assign(new Error(message), { code }); }
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function page(name, args, rows) {
  const { cursor, limit, ...filters } = args;
  const snapshot = digest({ name, filters, rows });
  let offset = 0;
  if (cursor) {
    let token;
    try { token = JSON.parse(Buffer.from(cursor, "base64url").toString()); }
    catch { failure("invalid_cursor", "Use the nextCursor returned by this operation."); }
    if (!token || typeof token !== "object") failure("invalid_cursor", "Invalid cursor.");
    if (token.snapshot !== snapshot) failure("stale_cursor", "The result changed. Restart this query without a cursor.");
    if (!Number.isInteger(token.offset) || token.offset < 0 || token.offset > rows.length) failure("invalid_cursor", "Invalid offset.");
    offset = token.offset;
  }
  const items = [];
  let chars = 0;
  while (offset + items.length < rows.length && items.length < limit) {
    const row = rows[offset + items.length];
    const size = JSON.stringify(row).length;
    if (size > 24000) failure("item_too_large", "Select a smaller object or read its diff/code by lines.");
    if (items.length && chars + size > 24000) break;
    items.push(row);
    chars += size;
  }
  const next = offset + items.length;
  return { snapshot, total: rows.length, offset, items,
    nextCursor: next < rows.length ? Buffer.from(JSON.stringify({ snapshot, offset: next })).toString("base64url") : null };
}

function safeRelative(file) {
  if (path.isAbsolute(file) || file.includes("\\") || file.includes("\0") || file.split("/").some(p => p === ".." || p === ".git")) {
    failure("outside_checkout", "Use a repository-relative path, without .. or .git.");
  }
  return file.replace(/^\.\//, "");
}

export function createReviewOperations(context) {
  const { root, checkout, key, revision, task, harness = "claude-code" } = context;
  if (!path.isAbsolute(root) || !path.isAbsolute(checkout) || !["chat", "analysis"].includes(task)) throw new Error("Explicit eval context required");
  const checkoutRoot = fs.realpathSync(checkout);
  const app = createApp({ stateDir: root, port: 4780, autoAnalyze: false, reviewRequestRefresh: false,
    updateChecker: false, webDist: path.join(root, "__no_web__") });
  let active = true;
  let queue = Promise.resolve();
  const records = [];
  const operations = new Map();
  const current = () => core.loadState(key, root);
  function check() {
    if (!active || (context.isActive && !context.isActive())) failure("revoked", "This run is no longer active.");
    if (current().currentRevision !== revision) failure("stale_revision", "The PR revision changed; start a new run.");
  }
  function git(args) {
    return execFileSync("git", ["--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", "-C", checkoutRoot, ...args], {
      env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LANG: "C.UTF-8" },
      encoding: "utf8", timeout: 10000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
  }
  function readFile(file) {
    const relative = safeRelative(file);
    const real = fs.realpathSync(path.join(checkoutRoot, relative));
    if (!real.startsWith(checkoutRoot + path.sep)) failure("outside_checkout", "The path resolves outside this run's checkout.");
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) failure("unsupported_file", "Read a regular text file of at most 2 MiB.");
    const text = fs.readFileSync(real, "utf8");
    if (text.includes("\0")) failure("unsupported_file", "Binary files are not supported.");
    return text;
  }
  const paths = () => git(["ls-files", "-z"]).split("\0").filter(Boolean).sort();
  const linesOf = text => text.split("\n").map((text, index) => ({ line: index + 1, text: text.slice(0, 2000), truncated: text.length > 2000 }));
  function add(name, description, shape, handler, kind = "read") {
    operations.set(name, { name, description, schema: z.object(shape).strict(), handler, kind });
  }
  const fileArgs = { path: relativePath, start: z.number().int().positive().default(1), ...pageArgs };
  add("review_context", "Bound PR/revision, files, task and remaining analysis work. Start here. File entries and all other large results are paginated.", pageArgs, args => {
    const state = current();
    return { pr: core.keyToString(key), revision, task, summary: state.summary,
      remaining: core.remainingWorkFor(key, root), files: page("review_context", args, core.readFilesJson(key, revision, root).files.map(f =>
        ({ path: f.path, oldPath: f.oldPath, hunks: f.hunks.map(h => ({ id: h.id, header: h.header })) }))) };
  });
  add("review_diff", "Diff bodies with old/new line gutters. Select by file, glob or hunk ID. Omit selectors for all; follow nextCursor until the needed bodies are read.", {
    selectors: z.array(z.string()).default([]), revision: revisionArg, ...pageArgs,
  }, args => {
    const files = core.readFilesJson(key, args.revision ?? revision, root);
    const selected = args.selectors.length ? core.selectHunks(files, args.selectors) : { hunks: core.allSelectedHunks(files), unknown: [] };
    if (selected.unknown.length) failure("unknown_selector", `Unknown or ambiguous selectors: ${selected.unknown.join(", ")}`);
    return { revision: args.revision ?? revision, ...page("review_diff", args,
      selected.hunks.flatMap(sh => core.renderShowHunk(sh).split("\n").map(text => ({ file: sh.file.path, hunkId: sh.hunk.id, text })))) };
  });
  add("review_units", "Current analysis units, including hunk ownership and findings.", pageArgs,
    args => page("review_units", args, Object.values(current().units)));
  add("review_changes", "Incremental work: migration report and pending work; compare revision diffs for code bodies.", pageArgs,
    args => ({ remaining: core.remainingWorkFor(key, root), ...page("review_changes", args, current().lastMigration?.entries ?? []) }));
  add("list_paths", "Tracked checkout paths, filtered by glob (supports * and **). No absolute paths or shell commands.", {
    include: z.string().default("**"), ...pageArgs,
  }, args => page("list_paths", args, paths().filter(p => core.globToRegExp(args.include).test(p))));
  add("read_code", "Read the head checkout by repository-relative path and line range. Binary/large files and paths/symlinks outside checkout are refused.", fileArgs,
    args => page("read_code", args, linesOf(readFile(args.path)).filter(l => l.line >= args.start)));
  add("search_code", "Search tracked checkout text for ANY of the literal patterns (not regex), with include/exclude globs and context. Follow nextCursor for more matches.", {
    patterns: z.array(z.string().min(1).max(200)).min(1).max(10), include: z.string().default("**"),
    exclude: z.array(z.string()).default([]), context: z.number().int().min(0).max(5).default(1), ...pageArgs,
  }, args => {
    const matches = [];
    const skipped = [];
    for (const file of paths().filter(p => core.globToRegExp(args.include).test(p) && !args.exclude.some(g => core.globToRegExp(g).test(p)))) {
      let text;
      try { text = readFile(file); } catch { skipped.push(file); continue; }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) if (args.patterns.some(p => lines[i].includes(p))) {
        matches.push({ file, line: i + 1, context: linesOf(lines.slice(Math.max(0, i - args.context), i + args.context + 1).join("\n"))
          .map(l => ({ ...l, line: l.line + Math.max(0, i - args.context) })) });
      }
    }
    return { skipped, ...page("search_code", args, matches) };
  });
  add("read_base_file", "Read a file at the recorded merge base; maps renamed paths. Added files are absent, never replaced by head content.", {
    ...fileArgs, revision: revisionArg,
  }, args => {
    const rev = args.revision ?? revision;
    const info = current().revisions.find(r => r.revision === rev);
    if (!info) failure("unknown_revision", "Unknown revision");
    const file = safeRelative(args.path);
    const renamed = core.readFilesJson(key, rev, root).files.find(f => f.path === file);
    const text = git(["show", `${info.mergeBase || info.baseSha}:${safeRelative(renamed?.oldPath ?? file)}`]);
    return { revision: rev, ...page("read_base_file", args, linesOf(text).filter(l => l.line >= args.start)) };
  });
  add("file_history", "Local file commit history, no network or arbitrary git arguments.", { path: relativePath, ...pageArgs }, args =>
    page("file_history", args, git(["log", "-100", "--format=%h %s", "--", safeRelative(args.path)]).trim().split("\n")));
  add("revision_diff", "Compare saved patch text from two PR revisions (diff of diffs), not checkout against a guessed base.", {
    from: z.number().int().positive(), to: z.number().int().positive(), ...pageArgs,
  }, args => page("revision_diff", args, core.diffOfDiffs(core.readDiff(key, args.from, root), core.readDiff(key, args.to, root)).lines));
  add("list_comments", "Current comments, preserving author identity, draft/published status and anchors.", pageArgs,
    args => page("list_comments", args, readComments(key, root)));

  if (task === "analysis") {
    // These are the actual core schemas, not a parallel copy of the payload.
    operations.set("set_analysis", { name: "set_analysis", kind: "write", schema: analysisInput,
      description: "Save validated analysis: summary, units and unassigned hunk IDs. Every hunk must be owned once. Returns coverage and remaining work.",
      handler: args => { const result = core.setAnalysis(key, args, {}, root); return { coverage: result.coverage, remaining: core.remainingWorkFor(key, root) }; } });
    add("patch_units", "Atomically validate and apply a batch of unit patches. Existing units accept partial fields; new units require full shape. Returns remaining work for later rounds.", {
      units: patchInput,
    }, args => { const result = core.setUnits(key, args.units.map(({ id, patch }) => ({ unitId: id, payload: patch })), root);
      return { unitIds: result.unitIds, warnings: result.warnings, remaining: core.remainingWorkFor(key, root) }; }, "write");
    add("set_revision_summary", "Save a nonempty summary for the bound revision (revision 1 has no separate summary).", {
      text: z.string().min(1),
    }, args => { const { text, warnings } = core.setRevisionSummary(key, args.text, revision, root); return { revision, text, warnings }; }, "write");
  } else {
    async function commentRequest(method, suffix, body) {
      const response = await app.request(`http://localhost:4780/api/prs/${encodeURIComponent(core.keyToString(key))}/comments${suffix}`, {
        method, headers: { "Content-Type": "application/json", "X-Purview-Actor": "chat", "X-Purview-Agent": harness },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await response.json();
      if (!response.ok) failure(data.error ?? "comment_error", data.detail ?? "Comment operation failed");
      return data;
    }
    function editable(id) {
      const target = readComments(key, root).find(c => c.id === id);
      if (!target) failure("outside_review", "No comment with that ID in this PR.");
      if (target.status !== "draft") failure("not_draft", "Only drafts may be changed.");
      if (!target.author || target.author === "you") failure("consent_required", "This eval does not grant edits to human drafts.");
    }
    add("create_draft", "Create one local draft at an existing diff anchor. Never publishes to GitHub.", commentInput,
      args => commentRequest("POST", "", args), "write");
    add("edit_draft", "Edit an agent-authored draft in this PR. Human or published comments are refused.", {
      id: z.string().min(1), body: z.string().min(1).max(20000),
    }, args => { editable(args.id); return commentRequest("PATCH", `/${encodeURIComponent(args.id)}`, { body: args.body }); }, "write");
    add("delete_draft", "Delete an agent-authored draft in this PR using Purview's existing trash/history behavior.", {
      id: z.string().min(1),
    }, args => { editable(args.id); return commentRequest("DELETE", `/${encodeURIComponent(args.id)}`); }, "write");
  }
  return {
    tools: [...operations.values()].map(({ handler, kind, ...tool }) => ({ ...tool, readOnly: kind === "read" })),
    records,
    revoke() { active = false; },
    execute(name, input = {}) {
      const result = queue.then(async () => {
        check();
        const operation = operations.get(name);
        if (!operation) failure("operation_not_granted", "Operation not granted for this task.");
        const args = operation.schema.parse(input);
        const value = await operation.handler(args);
        return value;
      });
      queue = result.catch(() => {});
      return result.then(value => { records.push({ name, ok: true }); return value; }, error => {
        records.push({ name, ok: false, code: error.code ?? "invalid_operation" }); throw error;
      });
    },
  };
}
