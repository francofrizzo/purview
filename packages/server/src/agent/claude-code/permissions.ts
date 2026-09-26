import os from "node:os";
import path from "node:path";
import { REVIEWER_COMMANDS, type AnalysisTask, type ChatTask, type ReviewerCommand } from "../types.js";

/**
 * Semantic tasks -> Claude Code tool rules. Callers say what a run may do;
 * this file is the only place that knows how Claude Code spells it.
 */

export interface ClaudeToolPolicy {
  tools: string[];
  allowedTools: string[];
  disallowedTools: string[];
  permissionMode?: "dontAsk";
}

/** The reviewer-state subcommands a task may NOT run, as deny rules. */
function deniedReviewerCommands(cli: string, allowed: readonly ReviewerCommand[]): string[] {
  // A rule matches whole words (`set-unit:*` does not cover `set-units`), so
  // every subcommand gets its own rule.
  return REVIEWER_COMMANDS.filter((sub) => !allowed.includes(sub)).map((sub) => `Bash(${cli} ${sub}:*)`);
}

/** Network and version control: denied for every task. */
const NETWORK_DENIALS = ["Bash(gh:*)", "Bash(git:*)", "Bash(curl:*)", "Bash(wget:*)"];

/**
 * The permission surface of an analysis run. Every piece is load-bearing:
 *
 *  - `permissionMode: "dontAsk"`: anything no allow rule (or Claude Code's
 *    built-in read-only set) covers is DENIED, never prompted. Without an
 *    explicit mode the run inherits the user's `permissions.defaultMode` —
 *    `auto` on most personal plans — where a classifier approves commands the
 *    allowlist never named: past runs executed `python3 -c`, `rm -f`, `node -e`
 *    and `> /tmp/…` redirects that way, and Write/Edit anywhere in the working
 *    directory (the PR state dir) skipped review entirely.
 *  - `--tools` removes every built-in tool except file reads, Bash and the
 *    two file writers.
 *  - Write/Edit are scoped with `Edit(...)` rules only: Claude Code consults
 *    Edit rules for every file-writing tool (and for redirect targets) and
 *    never consults a `Write(path)` rule, so the old `Write(scratch/**)`
 *    entries were no-ops.
 *  - Reads need no rule inside the working directories (cwd = the PR state
 *    dir, plus the --add-dir roots); bare `Read`/`Glob`/`Grep` allows, which
 *    opened the whole filesystem, are gone. The one read outside them is the
 *    session's own tool-results directory, where Claude Code spills a Bash
 *    result too large to show inline.
 *  - Bash: the reviewer-state CLI's allowed subcommands by its exact path,
 *    plus read-only inspection. A compound command is split and every part
 *    must match, so batching (`grep … && sed -n …`) runs while a chain with
 *    any unlisted command is denied as a whole. `sed` only as `sed -n`, with
 *    the in-place flag denied on top.
 *  - Deny rules (which beat allows) for every other subcommand, gh/git and
 *    the network.
 */
export function analysisPolicy(
  task: Pick<AnalysisTask, "scratchDir" | "reviewerCommands">,
  cli: string,
  opts: { transcriptDir?: string } = {},
): ClaudeToolPolicy & { permissionMode: "dontAsk" } {
  // Absolute-path permission rules use the `//` spelling; the cwd-relative
  // form rides along because the model may write either.
  const scratchAbs = `/${task.scratchDir}`;
  return {
    permissionMode: "dontAsk",
    // Write/Edit exist for exactly one purpose: composing the JSON payloads
    // the CLI is handed by path. The first flow (no file tools, JSON over
    // stdin with a heredoc) died in the field: newer CLI permission checkers
    // reject any Bash command containing quoted braces ("expansion
    // obfuscation"), and the model would then burn minutes re-generating the
    // full payload into other, equally rejected shapes. A file written once
    // and referenced by path sidesteps the checker and makes retries cheap.
    tools: ["Read", "Glob", "Grep", "Bash", "Write", "Edit"],
    allowedTools: [
      `Edit(${scratchAbs}/**)`,
      "Edit(scratch/**)",
      ...(opts.transcriptDir ? [`Read(/${opts.transcriptDir}/**)`] : []),
      ...task.reviewerCommands.map((sub) => `Bash(${cli} ${sub}:*)`),
      // Read-only investigation, batchable into one call. `sed` is allowed only
      // as `sed -n` so the in-place form can never be reached this way.
      "Bash(grep:*)",
      "Bash(rg:*)",
      "Bash(sed -n:*)",
      "Bash(ls:*)",
      "Bash(cat:*)",
      "Bash(head:*)",
      "Bash(tail:*)",
      "Bash(wc:*)",
    ],
    disallowedTools: [
      ...deniedReviewerCommands(cli, task.reviewerCommands),
      // `sed -n -i …` would otherwise match the `sed -n` allowance.
      "Bash(sed * -i*)",
      "Bash(sed * --in-place*)",
      ...NETWORK_DENIALS,
      "WebFetch",
      "WebSearch",
      // Edit is allowed only under scratch/ (above); deny rules would beat
      // the allow, so it must not appear here. Notebook editing has no
      // scratch use and stays denied outright.
      "NotebookEdit",
    ],
  };
}

/**
 * The permission surface of a chat turn: reads anywhere it can reach, the
 * allowed reviewer-state subcommands, no file writes, no network. Draft-only
 * comment mutation is enforced by the server (the chat's actor marker), not
 * by these rules.
 */
export function chatPolicy(task: Pick<ChatTask, "reviewerCommands">, cli: string): ClaudeToolPolicy {
  return {
    tools: ["Read", "Glob", "Grep", "Bash"],
    allowedTools: ["Read", "Glob", "Grep", ...task.reviewerCommands.map((sub) => `Bash(${cli} ${sub}:*)`)],
    disallowedTools: [
      ...deniedReviewerCommands(cli, task.reviewerCommands),
      ...NETWORK_DENIALS,
      "Write",
      "Edit",
      "NotebookEdit",
      "WebFetch",
      "WebSearch",
    ],
  };
}

/**
 * Where Claude Code keeps a session started in `cwd`: its transcript and the
 * `tool-results/` files it spills large outputs to.
 */
export function claudeProjectDir(cwd: string): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}
