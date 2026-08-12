import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setClaudeSpawner, type ClaudeChild } from "../src/claude-runner.js";

const CHILD = fileURLToPath(new URL("./fake-claude-child.mjs", import.meta.url));

export interface FakeClaudeOptions {
  /** raw stream-json objects the child prints */
  lines?: Record<string, unknown>[];
  exitCode?: number;
  /** run forever until SIGTERM (cancel / timeout tests) */
  hang?: boolean;
  stderr?: string;
}

export interface FakeClaude {
  /** one entry per spawn, in order */
  runs: { argv: string[]; cwd: string; prompt: string }[];
  install(): void;
  restore(): void;
  /** prompt of the nth run, readable even while that run is still going */
  promptOf(index: number): string;
  dir: string;
}

/** The stream-json a well-behaved run emits: init, some work, a result. */
export function scriptedRun(opts: {
  sessionId?: string;
  text?: string;
  tools?: { name: string; input: Record<string, unknown> }[];
  isError?: boolean;
} = {}): Record<string, unknown>[] {
  const sessionId = opts.sessionId ?? "11111111-2222-3333-4444-555555555555";
  const lines: Record<string, unknown>[] = [
    { type: "system", subtype: "init", session_id: sessionId, tools: ["Read", "Bash"] },
  ];
  for (const tool of opts.tools ?? []) {
    lines.push({
      type: "assistant",
      session_id: sessionId,
      message: { content: [{ type: "tool_use", name: tool.name, input: tool.input }] },
    });
  }
  if (opts.text !== undefined) {
    lines.push({
      type: "assistant",
      session_id: sessionId,
      message: { content: [{ type: "text", text: opts.text }] },
    });
  }
  lines.push({
    type: "result",
    subtype: opts.isError ? "error_during_execution" : "success",
    is_error: !!opts.isError,
    session_id: sessionId,
  });
  return lines;
}

/**
 * Replaces the `claude` spawn with a real child process running
 * fake-claude-child.mjs — the process, pipes, line framing and signals are all
 * genuine, only the model is not.
 */
export function fakeClaude(opts: FakeClaudeOptions = {}): FakeClaude {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-"));
  const argvFile = path.join(dir, "argv.jsonl");
  const runs: FakeClaude["runs"] = [];

  const install = () => {
    setClaudeSpawner((argv, spawnOpts) => {
      const promptFile = path.join(dir, `prompt-${runs.length}.txt`);
      const index = runs.length;
      runs.push({ argv, cwd: spawnOpts.cwd, prompt: "" });
      const child = spawn(process.execPath, [CHILD], {
        cwd: spawnOpts.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          FAKE_CLAUDE_LINES: JSON.stringify(opts.lines ?? scriptedRun()),
          FAKE_CLAUDE_EXIT: String(opts.exitCode ?? 0),
          FAKE_CLAUDE_PROMPT_FILE: promptFile,
          FAKE_CLAUDE_ARGV_FILE: argvFile,
          ...(opts.hang ? { FAKE_CLAUDE_HANG: "1" } : {}),
          ...(opts.stderr ? { FAKE_CLAUDE_STDERR: opts.stderr } : {}),
        },
      });
      child.on("exit", () => {
        if (fs.existsSync(promptFile)) runs[index].prompt = fs.readFileSync(promptFile, "utf8");
      });
      return child as unknown as ClaudeChild;
    });
  };

  return {
    runs,
    install,
    promptOf: (index: number) => {
      const file = path.join(dir, `prompt-${index}.txt`);
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    },
    restore: () => {
      setClaudeSpawner(null);
      fs.rmSync(dir, { recursive: true, force: true });
    },
    dir,
  };
}
