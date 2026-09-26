import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeCodeHarness, setClaudeSpawner } from "../src/agent/claude-code/index.js";
import type { AgentEvent, AgentRunRequest } from "../src/agent/types.js";
import { getHarness } from "../src/agent/registry.js";
import { cliCommand } from "../src/skill-paths.js";
import { fakeClaude, scriptedRun, type FakeClaude } from "./fake-claude.js";
import { analysisToolFlags, chatToolFlags } from "./claude-policies.js";

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "claude-harness-"));
const reanchor = (over: Partial<AgentRunRequest> = {}): AgentRunRequest => ({
  task: { kind: "reanchor" },
  prompt: "p",
  cwd,
  model: "sonnet",
  ...over,
});

let claude: FakeClaude | undefined;
afterEach(() => {
  claude?.restore();
  claude = undefined;
});

describe("registry", () => {
  it("resolves the default harness and refuses unknown ids", () => {
    expect(getHarness()).toBe(claudeCodeHarness);
    expect(getHarness("claude-code")).toBe(claudeCodeHarness);
    expect(() => getHarness("nope")).toThrow(/Unknown agent harness "nope"/);
  });
});

/**
 * The semantic tasks must translate to exactly the rules the callers used to
 * build by hand. Order is irrelevant to Claude Code; membership is the policy.
 */
describe("task -> Claude tool policy (unchanged from the pre-harness rules)", () => {
  const cmd = cliCommand();
  const sorted = (a: string[]) => [...a].sort();

  it("analysis", () => {
    const scratch = "/tmp/pr/scratch";
    const policy = analysisToolFlags(scratch, { transcriptDir: "/home/u/.claude/projects/x" });
    expect(policy.permissionMode).toBe("dontAsk");
    expect(policy.tools).toEqual(["Read", "Glob", "Grep", "Bash", "Write", "Edit"]);
    expect(sorted(policy.allowedTools)).toEqual(
      sorted([
        `Edit(/${scratch}/**)`,
        "Edit(scratch/**)",
        "Read(//home/u/.claude/projects/x/**)",
        ...["report", "list", "units", "triage", "show", "changes", "base-file", "set-analysis", "set-unit", "set-units"].map(
          (s) => `Bash(${cmd} ${s}:*)`,
        ),
        ...["grep:*", "rg:*", "sed -n:*", "ls:*", "cat:*", "head:*", "tail:*", "wc:*"].map((r) => `Bash(${r})`),
      ]),
    );
    expect(sorted(policy.disallowedTools)).toEqual(
      sorted([
        ...["sync", "init", "refresh", "discard-revision", "remove-repo", "comment", "view"].map(
          (s) => `Bash(${cmd} ${s}:*)`,
        ),
        "Bash(sed * -i*)",
        "Bash(sed * --in-place*)",
        "Bash(gh:*)",
        "Bash(git:*)",
        "Bash(curl:*)",
        "Bash(wget:*)",
        "WebFetch",
        "WebSearch",
        "NotebookEdit",
      ]),
    );
  });

  it("chat", () => {
    const policy = chatToolFlags();
    expect(policy.permissionMode).toBeUndefined();
    expect(policy.tools).toEqual(["Read", "Glob", "Grep", "Bash"]);
    expect(sorted(policy.allowedTools)).toEqual(
      sorted([
        "Read",
        "Glob",
        "Grep",
        ...["report", "list", "triage", "show", "changes", "units", "base-file", "comment"].map((s) => `Bash(${cmd} ${s}:*)`),
      ]),
    );
    expect(sorted(policy.disallowedTools)).toEqual(
      sorted([
        ...["sync", "set-analysis", "set-unit", "set-units", "view", "init", "refresh", "discard-revision", "remove-repo"].map(
          (s) => `Bash(${cmd} ${s}:*)`,
        ),
        "Bash(gh:*)",
        "Bash(git:*)",
        "Bash(curl:*)",
        "Bash(wget:*)",
        "Write",
        "Edit",
        "NotebookEdit",
        "WebFetch",
        "WebSearch",
      ]),
    );
  });
});

describe("runs", () => {
  it("runs a re-anchor tool-free, with the model explicit and no session flags", async () => {
    claude = fakeClaude({ lines: scriptedRun({ text: "{}" }) });
    claude.install();
    const events = await collect(claudeCodeHarness.run(reanchor()).events);
    const argv = claude.runs[0].argv;
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(argv[argv.indexOf("--model") + 1]).toBe("sonnet");
    expect(argv).not.toContain("--session-id");
    expect(argv).not.toContain("--resume");
    expect(events.at(-1)).toMatchObject({ type: "completed", ok: true });
    expect(events.filter((e) => e.type === "completed")).toHaveLength(1);
  });

  it('omits --effort for "none" and passes any other level through', async () => {
    claude = fakeClaude();
    claude.install();
    await collect(claudeCodeHarness.run(reanchor({ effort: "none" })).events);
    await collect(claudeCodeHarness.run(reanchor({ effort: "high" })).events);
    expect(claude.runs[0].argv).not.toContain("--effort");
    expect(claude.runs[1].argv.slice(claude.runs[1].argv.indexOf("--effort"))).toContain("high");
  });

  it("announces a new session before any output, and pins its id with --session-id", async () => {
    claude = fakeClaude({ hang: false, lines: [{ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }] });
    claude.install();
    const events = await collect(claudeCodeHarness.run(reanchor({ session: "new" })).events);
    expect(events[0].type).toBe("session");
    if (events[0].type !== "session") throw new Error("unreachable");
    const { id } = events[0].session;
    expect(events[0].session).toEqual({ harness: "claude-code", id, cwd });
    const argv = claude.runs[0].argv;
    expect(argv[argv.indexOf("--session-id") + 1]).toBe(id);
    // No init line arrived, yet the completion still names the session.
    expect(events.at(-1)).toMatchObject({ type: "completed", ok: true, session: { id } });
  });

  it("resumes only its own sessions, and only from the cwd they were started in", async () => {
    const own = { harness: "claude-code", id: "abc", cwd };
    expect(claudeCodeHarness.canResume(own, cwd)).toBe(true);
    expect(claudeCodeHarness.canResume(own, "/elsewhere")).toBe(false);
    expect(claudeCodeHarness.canResume({ ...own, harness: "other" }, cwd)).toBe(false);

    claude = fakeClaude();
    claude.install();
    const refused = await collect(claudeCodeHarness.run(reanchor({ session: { ...own, harness: "other" } })).events);
    expect(refused).toEqual([{ type: "completed", ok: false, error: expect.stringMatching(/cannot resume other session abc/) }]);
    expect(claude.runs).toHaveLength(0);

    await collect(claudeCodeHarness.run(reanchor({ session: own })).events);
    const argv = claude.runs[0].argv;
    expect(argv[argv.indexOf("--resume") + 1]).toBe("abc");
  });

  it("folds an error result into the completion error", async () => {
    claude = fakeClaude({ exitCode: 3, stderr: "boom", lines: scriptedRun({ isError: true }) });
    claude.install();
    const events = await collect(claudeCodeHarness.run(reanchor()).events);
    expect(events.some((e) => e.type === "action")).toBe(false);
    expect(events.at(-1)).toEqual({
      type: "completed",
      ok: false,
      error: "claude exited with code 3 (error_during_execution): boom",
      session: { harness: "claude-code", id: "11111111-2222-3333-4444-555555555555", cwd },
    });
  });

  it("completes exactly once when the process cannot be started", async () => {
    setClaudeSpawner(() => {
      throw new Error("ENOENT");
    });
    try {
      const events = await collect(claudeCodeHarness.run(reanchor()).events);
      expect(events).toEqual([{ type: "completed", ok: false, error: "could not start claude: ENOENT" }]);
    } finally {
      setClaudeSpawner(null);
    }
  });

  it("completes as cancelled when cancelled mid-run", async () => {
    claude = fakeClaude({ hang: true });
    claude.install();
    const run = claudeCodeHarness.run(reanchor());
    setTimeout(() => run.cancel(), 50);
    const events = await collect(run.events);
    expect(events.at(-1)).toMatchObject({ type: "completed", ok: false, error: "cancelled" });
  });
});

describe("handoff", () => {
  it("resumes a fork of the session from its cwd, granting roots other than the cwd", () => {
    const { command } = claudeCodeHarness.createHandoff!(
      { harness: "claude-code", id: "abc", cwd: "/work" },
      { contextPath: "/state/ctx.md", readRoots: ["/work", "/state", "/skills"] },
    );
    expect(command).toBe(
      `cd '/work' && claude --resume abc --fork-session --append-system-prompt "$(cat '/state/ctx.md')"` +
        ` --add-dir '/state' --add-dir '/skills'`,
    );
  });
});

describe("probe", () => {
  it("reports the version line, or where to get the CLI", () => {
    expect(claudeCodeHarness.probe(() => ({ ok: true, stdout: "2.0.14 (Claude Code)\n", stderr: "" }))).toEqual({
      available: true,
      version: "2.0.14 (Claude Code)",
      detail: "2.0.14 (Claude Code)",
    });
    expect(claudeCodeHarness.probe(() => ({ ok: false, stdout: "", stderr: "" }))).toMatchObject({
      available: false,
      setupHint: expect.stringContaining("claude.com/claude-code"),
    });
  });
});
