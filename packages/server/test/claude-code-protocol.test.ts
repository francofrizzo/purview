import { describe, expect, it } from "vitest";
import { buildArgv, translate } from "../src/agent/claude-code/protocol.js";

/**
 * Unit tests for `translate()`'s handling of the stream-json `result` line —
 * see the analysis run in analysis.ts (and claude.test.ts's "analysis job
 * lifecycle" for the end-to-end metrics wiring).
 */
describe("translate: result line", () => {
  it("emits a usage event with every timing/cost/usage field on a clean success", () => {
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
        type: "usage",
        usage: {
          turns: 12,
          durationMs: 45_000,
          apiDurationMs: 30_000,
          costUsd: 0.42,
          inputTokens: 100,
          cacheCreationInputTokens: 50,
          cacheReadInputTokens: 900,
          outputTokens: 200,
        },
      },
    ]);
  });

  it("still emits the usage event (plus a result-error for the harness to fold into completion) on an error result", () => {
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
      { type: "result-error", detail: "boom" },
      { type: "usage", usage: expect.objectContaining({ turns: 3, durationMs: 1000, costUsd: undefined }) },
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
        type: "usage",
        usage: {
          turns: undefined,
          durationMs: undefined,
          apiDurationMs: undefined,
          costUsd: 0.1,
          inputTokens: 5,
          cacheCreationInputTokens: undefined,
          cacheReadInputTokens: undefined,
          outputTokens: undefined,
        },
      },
    ]);
  });

  it("emits an all-empty usage event when the line carries none of the fields", () => {
    const events = translate({ type: "result", subtype: "success", is_error: false }, false);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("usage");
    if (events[0].type !== "usage") throw new Error("unreachable");
    expect(Object.values(events[0].usage).every((v) => v === undefined)).toBe(true);
  });
});

describe("translate: tool_use becomes an action with an untruncated target", () => {
  it("keeps the full command in target even when summary is truncated past 200 chars", () => {
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
    expect(event.type).toBe("action");
    if (event.type !== "action") throw new Error("unreachable");
    expect(event.action.kind).toBe("command");
    expect(event.action.name).toBe("Bash");
    expect(event.action.target).toBe(longCommand);
    expect(event.action.summary.length).toBeLessThanOrEqual(200);
    expect(event.action.summary.endsWith("...")).toBe(true);
  });

  it("classifies Claude's tools into action kinds", () => {
    const kindOf = (name: string, input: Record<string, unknown>) => {
      const [event] = translate({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } }, false);
      return event.type === "action" ? [event.action.kind, event.action.target] : undefined;
    };
    expect(kindOf("Read", { file_path: "/a" })).toEqual(["read", "/a"]);
    expect(kindOf("Write", { file_path: "/s/x.json" })).toEqual(["write", "/s/x.json"]);
    expect(kindOf("Edit", { file_path: "/s/x.json" })).toEqual(["write", "/s/x.json"]);
    expect(kindOf("Grep", { pattern: "foo" })).toEqual(["search", "foo"]);
    expect(kindOf("Glob", { pattern: "**/*.ts" })).toEqual(["search", "**/*.ts"]);
    expect(kindOf("WebFetch", { url: "https://x" })).toEqual(["tool", "https://x"]);
  });
});

describe("buildArgv: permission mode and a stable system prompt", () => {
  it("passes --permission-mode and moves dynamic sections out of the system prompt only when asked", () => {
    const argv = buildArgv({
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

    const plain = buildArgv({});
    expect(plain).not.toContain("--permission-mode");
    expect(plain).not.toContain("--exclude-dynamic-system-prompt-sections");
  });
});
