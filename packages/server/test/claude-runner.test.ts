import { describe, expect, it } from "vitest";
import { buildArgv, translate } from "../src/claude-runner.js";

/**
 * Unit tests for `translate()`'s handling of the stream-json `result` line —
 * see analysis.ts's runOne (and claude.test.ts's "analysis job lifecycle" for
 * the end-to-end metrics wiring).
 */
describe("translate: result line", () => {
  it("emits a result event with every timing/cost/usage field on a clean success", () => {
    const events = translate(
      {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 12,
        duration_ms: 45_000,
        duration_api_ms: 30_000,
        total_cost_usd: 0.42,
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 50,
          cache_read_input_tokens: 900,
          output_tokens: 200,
        },
      },
      false,
    );
    expect(events).toEqual([
      {
        type: "result",
        numTurns: 12,
        durationMs: 45_000,
        durationApiMs: 30_000,
        costUsd: 0.42,
        usage: { input: 100, cacheCreation: 50, cacheRead: 900, output: 200 },
      },
    ]);
  });

  it("still emits the result event (plus the existing result-error tool event) on an error result", () => {
    const events = translate(
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["boom"],
        num_turns: 3,
        duration_ms: 1000,
      },
      false,
    );
    expect(events).toEqual([
      { type: "tool", name: "result-error", detail: "boom" },
      { type: "result", numTurns: 3, durationMs: 1000, durationApiMs: undefined, costUsd: undefined, usage: undefined },
    ]);
  });

  it("omits fields that are missing or non-numeric instead of coercing them", () => {
    const events = translate(
      {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: "twelve", // wrong type — must be dropped, not coerced
        total_cost_usd: 0.1,
        usage: { input_tokens: 5 }, // partial usage object
      },
      false,
    );
    expect(events).toEqual([
      {
        type: "result",
        numTurns: undefined,
        durationMs: undefined,
        durationApiMs: undefined,
        costUsd: 0.1,
        usage: { input: 5, cacheCreation: undefined, cacheRead: undefined, output: undefined },
      },
    ]);
  });

  it("emits a bare result event (no usage) when the line carries none of the fields", () => {
    const events = translate({ type: "result", subtype: "success", is_error: false }, false);
    expect(events).toEqual([
      {
        type: "result",
        numTurns: undefined,
        durationMs: undefined,
        durationApiMs: undefined,
        costUsd: undefined,
        usage: undefined,
      },
    ]);
  });
});

describe("translate: tool_use carries a raw, untruncated detail", () => {
  it("keeps the full command in rawDetail even when detail is truncated past 200 chars", () => {
    const longCommand = "grep -n " + "x".repeat(250);
    const events = translate(
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Bash", input: { command: longCommand } }],
        },
      },
      false,
    );
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.type).toBe("tool");
    if (event.type !== "tool") throw new Error("unreachable");
    expect(event.rawDetail).toBe(longCommand);
    expect(event.detail.length).toBeLessThanOrEqual(200);
    expect(event.detail.endsWith("...")).toBe(true);
  });
});

describe("buildArgv: permission mode and a stable system prompt", () => {
  it("passes --permission-mode and moves dynamic sections out of the system prompt only when asked", () => {
    const argv = buildArgv({
      prompt: "p",
      cwd: "/x",
      permissionMode: "dontAsk",
      systemPrompt: "STABLE",
      stableSystemPrompt: true,
    });
    expect(argv.slice(argv.indexOf("--permission-mode"), argv.indexOf("--permission-mode") + 2)).toEqual([
      "--permission-mode",
      "dontAsk",
    ]);
    expect(argv).toContain("--exclude-dynamic-system-prompt-sections");
    expect(argv[argv.indexOf("--append-system-prompt") + 1]).toBe("STABLE");

    const plain = buildArgv({ prompt: "p", cwd: "/x" });
    expect(plain).not.toContain("--permission-mode");
    expect(plain).not.toContain("--exclude-dynamic-system-prompt-sections");
  });
});
