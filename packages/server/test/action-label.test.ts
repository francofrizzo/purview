import { describe, expect, it } from "vitest";
import { actionLabel } from "../src/agent/types.js";
import { describeArgs } from "../src/agent/review-tools/operations.js";

describe("actionLabel", () => {
  it("names the built-in harness tools for the reader", () => {
    expect(actionLabel("Bash")).toBe("Run");
    expect(actionLabel("Grep")).toBe("Search");
    expect(actionLabel("Glob")).toBe("Find files");
    expect(actionLabel("checkout")).toBe("Checkout");
  });
  it("humanizes shared review tools, with or without an MCP prefix", () => {
    expect(actionLabel("review_units")).toBe("Review units");
    expect(actionLabel("mcp__purview__search_code")).toBe("Search code");
    expect(actionLabel("purview_read_code")).toBe("Read code");
  });
  it("leaves an unknown name alone", () => expect(actionLabel("SomethingElse")).toBe("SomethingElse"));
});

describe("describeArgs", () => {
  it("shows the arguments without paging, path with its start line", () => {
    expect(describeArgs({ path: "src/a.ts", start: 120, cursor: "x", limit: 100 })).toBe("src/a.ts:120");
    expect(describeArgs({ path: "src/a.ts", start: 1 })).toBe("src/a.ts");
    expect(describeArgs({ select: ["unit:core", "h3"], include: "**/*.ts" })).toBe("unit:core, h3 · **/*.ts");
    expect(describeArgs({ from: 2, to: 3 })).toBe("2 · 3");
    expect(describeArgs({ cursor: "x" })).toBe("");
    expect(describeArgs(undefined)).toBe("");
  });
  it("caps the line", () => expect(describeArgs({ patterns: ["x".repeat(300)] }).length).toBe(200));
});
