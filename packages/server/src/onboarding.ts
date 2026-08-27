import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { configPath, stateRoot } from "@reviewer/core";
import { DEFAULT_CONFIG, configExists, writeConfig, type ReviewerConfig } from "./config.js";

/**
 * First-run onboarding for the terminal.
 *
 * Runs once, before the server starts listening, when there is no
 * `~/.purview/config.json` and stdout is a TTY. It exists to do three things a
 * silent boot cannot: tell the user what has to be installed for the app to
 * work, get explicit consent for spending on their own Claude account, and show
 * them where to go next.
 *
 * Everything here is injectable so it can be tested without a terminal, a
 * `gh` binary or a real Claude subscription: the environment probes take an
 * `Exec`, and the prompt loop takes an `OnboardingIo`.
 */

/* ------------------------------------------------------------------ colors */

export interface Palette {
  accent(s: string): string;
  bold(s: string): string;
  dim(s: string): string;
  ok(s: string): string;
  warn(s: string): string;
  bad(s: string): string;
}

const identity = (s: string) => s;

/**
 * NO_COLOR (any value) and non-TTY output both fall back to plain text — the
 * output has to stay readable when piped into a file or a CI log.
 */
export function makePalette(enabled: boolean): Palette {
  if (!enabled) {
    return { accent: identity, bold: identity, dim: identity, ok: identity, warn: identity, bad: identity };
  }
  const wrap = (code: string) => (s: string) => `\u001b[${code}m${s}\u001b[0m`;
  return {
    accent: wrap("38;5;79"),
    bold: wrap("1"),
    dim: wrap("2"),
    ok: wrap("32"),
    warn: wrap("33"),
    bad: wrap("31"),
  };
}

export function colorsEnabled(
  env: NodeJS.ProcessEnv = process.env,
  isTty = Boolean(process.stdout.isTTY),
): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  return isTty;
}

/* ------------------------------------------------------------------ checks */

export type CheckStatus = "pass" | "warn" | "fail";

export interface CheckResult {
  id: "node" | "gh" | "claude" | "statedir";
  label: string;
  status: CheckStatus;
  /** One-line result detail, e.g. the detected `gh` login or version. */
  detail?: string;
  /** Shown only on warn/fail: what the user should do about it. */
  hint?: string;
}

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Injectable process runner. Returns ok:false rather than throwing. */
export type Exec = (cmd: string, args: string[]) => ExecResult;

export const realExec: Exec = (cmd, args) => {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 15_000 });
    return {
      ok: r.status === 0,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    };
  } catch (err) {
    return { ok: false, stdout: "", stderr: (err as Error).message };
  }
};

export function checkNode(version = process.version): CheckResult {
  const major = Number(/^v?(\d+)/.exec(version)?.[1] ?? NaN);
  const pass = Number.isFinite(major) && major >= 20;
  return {
    id: "node",
    label: "Node.js >= 20",
    status: pass ? "pass" : "fail",
    detail: version,
    hint: pass ? undefined : "Install Node 20 or newer: https://nodejs.org/en/download",
  };
}

/**
 * `gh` has to be both installed and authenticated: every GitHub read and write
 * in the app goes through it, so a missing login means nothing works.
 * `gh auth status` prints to stderr, hence reading both streams.
 */
export function checkGh(exec: Exec): CheckResult {
  const version = exec("gh", ["--version"]);
  if (!version.ok) {
    return {
      id: "gh",
      label: "gh installed + authenticated",
      status: "fail",
      detail: "not found",
      hint: "Install the GitHub CLI: https://cli.github.com/",
    };
  }
  const status = exec("gh", ["auth", "status"]);
  const text = `${status.stdout}\n${status.stderr}`;
  if (!status.ok) {
    return {
      id: "gh",
      label: "gh installed + authenticated",
      status: "fail",
      detail: "installed, not logged in",
      hint: "Authenticate with: gh auth login",
    };
  }
  const login = /Logged in to \S+ (?:account |as )?([A-Za-z0-9-]+)/.exec(text)?.[1];
  return {
    id: "gh",
    label: "gh installed + authenticated",
    status: "pass",
    detail: login ? `logged in as ${login}` : "logged in",
  };
}

/**
 * `claude` failing is soft: the diff viewer, GitHub sync and the whole review
 * lifecycle work without it. Only automatic analysis and the review chat do not.
 */
export function checkClaude(exec: Exec): CheckResult {
  const r = exec("claude", ["--version"]);
  if (!r.ok) {
    return {
      id: "claude",
      label: "claude CLI available",
      status: "warn",
      detail: "not found",
      hint: "Optional. Install to enable analysis + chat: https://claude.com/claude-code",
    };
  }
  return {
    id: "claude",
    label: "claude CLI available",
    status: "pass",
    detail: r.stdout.trim().split("\n")[0] || "ok",
  };
}

/** The state dir must be creatable and writable — everything persists there. */
export function checkStateDir(root: string): CheckResult {
  const label = "state directory writable";
  try {
    fs.mkdirSync(root, { recursive: true });
    const probe = path.join(root, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, "");
    fs.rmSync(probe, { force: true });
    return { id: "statedir", label, status: "pass", detail: root };
  } catch (err) {
    return {
      id: "statedir",
      label,
      status: "fail",
      detail: root,
      hint: `Cannot write there (${(err as Error).message}). Fix permissions or set REVIEWER_STATE_DIR.`,
    };
  }
}

/* --------------------------------------------------------------- decisions */

export interface SkipDecision {
  onboard: boolean;
  reason?: "config-exists" | "not-a-tty";
}

/**
 * `--onboard` forces a re-run (and is the only way to re-run once the config
 * file exists). Otherwise: only on a first run, and only on a real terminal —
 * a non-TTY boot (systemd, a script, a test) must never block on a prompt.
 */
export function shouldOnboard(input: {
  root: string;
  isTty: boolean;
  force?: boolean;
}): SkipDecision {
  if (input.force) return { onboard: true };
  if (!input.isTty) return { onboard: false, reason: "not-a-tty" };
  if (configExists(input.root)) return { onboard: false, reason: "config-exists" };
  return { onboard: true };
}

/* ---------------------------------------------------------------------- io */

export interface OnboardingIo {
  write(text: string): void;
  question(prompt: string): Promise<string>;
  close(): void;
}

/** Real terminal io over node:readline. */
export function createTerminalIo(): OnboardingIo {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    write: (text) => process.stdout.write(text),
    question: (prompt) => new Promise<string>((resolve) => rl.question(prompt, resolve)),
    close: () => rl.close(),
  };
}

/* -------------------------------------------------------------- rendering */

const GLYPH: Record<CheckStatus, string> = { pass: "✓", warn: "!", fail: "✗" };

function statusGlyph(status: CheckStatus, p: Palette): string {
  const g = GLYPH[status];
  return status === "pass" ? p.ok(g) : status === "warn" ? p.warn(g) : p.bad(g);
}

/** Strips SGR sequences so a colored string can be measured for alignment. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

const WORDMARK = "P U R V I E W";
const TAGLINE = "a local-first pull request review desk";

/**
 * Deliberately not a figlet: three lines, box-drawing only, so it still reads
 * as a header in an 80-column terminal and does not dominate the output.
 */
export function renderBanner(p: Palette): string {
  const inner = TAGLINE.length + 2;
  const trailing = inner - WORDMARK.length - 3;
  return [
    "  " +
      p.accent("╭─ ") +
      p.accent(p.bold(WORDMARK)) +
      p.accent(" " + "─".repeat(trailing) + "╮"),
    "  " + p.accent("│") + " " + TAGLINE + " " + p.accent("│"),
    "  " + p.accent("╰" + "─".repeat(inner) + "╯"),
    "",
    "",
  ].join("\n");
}

export function renderCheck(check: CheckResult, p: Palette): string {
  const head = `  ${statusGlyph(check.status, p)} ${check.label}${
    check.detail ? p.dim(` — ${check.detail}`) : ""
  }`;
  return check.hint ? `${head}\n    ${p.dim("→ " + check.hint)}` : head;
}

/** Pads to a fixed inner width, ignoring ANSI escapes when measuring. */
function padVisible(text: string, width: number): string {
  const visible = stripAnsi(text).length;
  return text + " ".repeat(Math.max(0, width - visible));
}

export function renderSummary(
  input: { root: string; port: number; claudeReady: boolean; autoAnalyze: boolean },
  p: Palette,
): string {
  const url = `http://localhost:${input.port}`;
  const lines = [
    `${p.bold("state")}     ${input.root}`,
    `${p.bold("port")}      ${input.port}`,
    `${p.bold("open")}      ${p.accent(url)}`,
    `${p.bold("analysis")}  ${input.autoAnalyze ? "automatic on add" : "manual only"}`,
  ];
  if (input.claudeReady) {
    lines.push(p.dim("pr-review skill and review chat are ready"));
  } else {
    lines.push(p.dim("no claude CLI: analysis and chat are unavailable"));
  }
  const width = Math.max(
    ...lines.map((l) => stripAnsi(l).length),
  );
  const top = p.accent("  ╭" + "─".repeat(width + 2) + "╮");
  const bottom = p.accent("  ╰" + "─".repeat(width + 2) + "╯");
  const body = lines.map((l) => `  ${p.accent("│")} ${padVisible(l, width)} ${p.accent("│")}`);
  return [top, ...body, bottom].join("\n");
}

/* ------------------------------------------------------------------ prompt */

/** Parses a [Y/n]-style answer; empty input takes `fallback`. */
export function parseYesNo(answer: string, fallback: boolean): boolean {
  const a = answer.trim().toLowerCase();
  if (a === "") return fallback;
  return a === "y" || a === "yes";
}

/* -------------------------------------------------------------------- flow */

export interface OnboardingDeps {
  root?: string;
  port?: number;
  io: OnboardingIo;
  exec?: Exec;
  palette?: Palette;
  nodeVersion?: string;
  now?: () => Date;
}

export interface OnboardingResult {
  /** The config that was written (undefined when the user aborted). */
  config?: ReviewerConfig;
  checks: CheckResult[];
  /** True when a hard-stop check failed and the user declined to continue. */
  aborted: boolean;
}

/**
 * The whole first-run flow: banner, live checks, cost consent, config write,
 * summary. Returns the written config so the caller can boot with it without
 * re-reading the file.
 */
export async function runOnboarding(deps: OnboardingDeps): Promise<OnboardingResult> {
  const root = deps.root ?? stateRoot();
  const port = deps.port ?? 4779;
  const exec = deps.exec ?? realExec;
  const p = deps.palette ?? makePalette(colorsEnabled());
  const io = deps.io;
  const now = deps.now ?? (() => new Date());

  io.write("\n" + renderBanner(p));
  io.write(p.bold("  Checking your environment\n\n"));

  // Run and print one at a time: each probe shells out, so the list filling in
  // line by line is the honest representation of what is happening.
  const checks: CheckResult[] = [];
  const run = (fn: () => CheckResult) => {
    const result = fn();
    checks.push(result);
    io.write(renderCheck(result, p) + "\n");
    return result;
  };

  run(() => checkNode(deps.nodeVersion));
  const gh = run(() => checkGh(exec));
  const claude = run(() => checkClaude(exec));
  run(() => checkStateDir(root));

  io.write("\n");

  // gh is a hard stop: without it the app cannot fetch a single PR. Still
  // offered as a y/N rather than an exit, because a user may be about to run
  // `gh auth login` in another window.
  if (gh.status === "fail") {
    io.write(
      p.bad("  gh is required — every GitHub read and write goes through it.\n") +
        p.dim("  Nothing will load until it is installed and authenticated.\n\n"),
    );
    const answer = await io.question("  Continue anyway? [y/N] ");
    io.write("\n");
    if (!parseYesNo(answer, false)) {
      io.write(p.dim("  Stopped. Run the server again once gh is ready.\n\n"));
      return { checks, aborted: true };
    }
  }

  if (claude.status !== "pass") {
    io.write(
      p.warn("  Without the claude CLI, automatic analysis and review chat are unavailable.\n") +
        p.dim("  Everything else — diff viewer, comments, sync, review submit — still works.\n\n"),
    );
  }

  // Cost consent. This has to be plain: the runs are on the user's own account.
  io.write(p.bold("  About cost\n"));
  io.write(
    "  Adding a PR here starts a Claude analysis run automatically, and every\n" +
      "  chat message starts another. Both run on " +
      p.bold("your own Claude account or\n  subscription") +
      " through the claude CLI you are already signed into —\n" +
      "  there are no API keys here, and usage counts against your plan.\n\n" +
      p.dim("  Analysis and chat both run on Sonnet by default — change the model in\n  Settings → Claude, or per repo in the repo settings.\n") +
      p.dim("  You can change this later in ") +
      p.dim(configPath(root)) +
      p.dim(",\n  per repo in the repo settings, or for one run with PURVIEW_AUTO_ANALYZE=0.\n\n"),
  );

  const answer = await io.question("  Run an analysis automatically when you add a PR? [Y/n] ");
  const autoAnalyze = parseYesNo(answer, true);
  io.write("\n");

  const config = writeConfig(
    {
      autoAnalyze,
      onboardedAt: now().toISOString(),
      devOrigins: DEFAULT_CONFIG.devOrigins,
    },
    root,
  );

  io.write(
    renderSummary({ root, port, claudeReady: claude.status === "pass", autoAnalyze }, p) + "\n\n",
  );

  return { config, checks, aborted: false };
}

/**
 * Entry point used by index.ts: decides whether to onboard, runs it with real
 * terminal io, and always closes the readline interface. Returns undefined when
 * onboarding was skipped, so the caller falls back to the stored config.
 */
export async function maybeOnboard(input: {
  root?: string;
  port: number;
  force?: boolean;
  isTty?: boolean;
}): Promise<OnboardingResult | undefined> {
  const root = input.root ?? stateRoot();
  const isTty = input.isTty ?? Boolean(process.stdout.isTTY && process.stdin.isTTY);
  const decision = shouldOnboard({ root, isTty, force: input.force });
  if (!decision.onboard) return undefined;
  const io = createTerminalIo();
  try {
    return await runOnboarding({ root, port: input.port, io });
  } finally {
    io.close();
  }
}
