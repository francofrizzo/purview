import { describe, expect, it } from "vitest";
import { evidenceParts, hunkAtLine, resolveCodeTarget, resolveDiffPath } from "./codeLinks";

const files = [
  { path: "pkg/openairesponses/rollout.go" },
  { path: "pkg/llm/chatbot/chatbot.go" },
  { path: "pkg/llm/chatbotv2/chatbot.go" },
  { path: "evals/whatsapp_intermediary_la_segunda.go" },
];
const ctx = { unitIds: new Set(["bedrock-failover-config-overrides"]), files };

describe("resolveCodeTarget", () => {
  it("reads a unit id exactly", () => {
    expect(resolveCodeTarget("bedrock-failover-config-overrides", ctx)).toEqual({
      kind: "unit",
      unitId: "bedrock-failover-config-overrides",
    });
    expect(resolveCodeTarget("bedrock-failover", ctx)).toBeNull();
  });

  it("reads a path with a line, an approximate line, or a range", () => {
    expect(resolveCodeTarget("pkg/openairesponses/rollout.go:23", ctx)).toEqual({
      kind: "file",
      path: "pkg/openairesponses/rollout.go",
      line: 23,
    });
    expect(resolveCodeTarget("whatsapp_intermediary_la_segunda.go:~551-567", ctx)).toEqual({
      kind: "file",
      path: "evals/whatsapp_intermediary_la_segunda.go",
      line: 551,
    });
    expect(resolveCodeTarget("rollout.go", ctx)).toEqual({
      kind: "file",
      path: "pkg/openairesponses/rollout.go",
    });
  });

  it("links nothing it would have to guess", () => {
    expect(resolveCodeTarget("chatbot.go:10", ctx)).toBeNull(); // two files end with it
    expect(resolveCodeTarget("main.go:1161", ctx)).toBeNull(); // not in the diff
    expect(resolveCodeTarget("sync.Once", ctx)).toBeNull();
    expect(resolveCodeTarget("invalidOnce", ctx)).toBeNull();
  });
});

describe("resolveDiffPath", () => {
  it("prefers the exact path, else a unique suffix at a path boundary", () => {
    expect(resolveDiffPath("llm/chatbot/chatbot.go", files)).toBe("pkg/llm/chatbot/chatbot.go");
    expect(resolveDiffPath("otbot.go", files)).toBeNull();
  });
});

describe("hunkAtLine", () => {
  const hunks = [
    { id: "a", newStart: 10, newLines: 5 },
    { id: "b", newStart: 40, newLines: 0 },
  ];
  it("finds the hunk covering a new-side line", () => {
    expect(hunkAtLine(hunks, 12)).toBe("a");
    expect(hunkAtLine(hunks, 15)).toBeNull();
    expect(hunkAtLine(hunks, 40)).toBe("b");
  });
});

describe("evidenceParts", () => {
  const join = (parts: { text: string }[]) => parts.map((p) => p.text).join("");
  const refs = (evidence: string) => evidenceParts(evidence).filter((p) => p.ref).map((p) => p.text);

  it("cuts a comma list into its places, keeping the separators as text", () => {
    const e = "src/payments/refund.ts:64, src/payments/ledger.ts:31";
    expect(refs(e)).toEqual(["src/payments/refund.ts:64", "src/payments/ledger.ts:31"]);
    expect(join(evidenceParts(e))).toBe(e);
  });

  it("leaves a trailing period and surrounding prose as text", () => {
    const e = "callers in api/pay.ts:88 (and jobs/retry.ts:~41-50).";
    expect(refs(e)).toEqual(["callers", "in", "api/pay.ts:88", "and", "jobs/retry.ts:~41-50"]);
    expect(join(evidenceParts(e))).toBe(e);
  });
});
