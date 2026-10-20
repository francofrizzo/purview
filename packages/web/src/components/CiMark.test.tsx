import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CiMark } from "./Chips";
import type { Ci } from "../api/types";

const ci: Ci = {
  state: "failure", headSha: "head", checkedAt: "2026-10-20T12:00:00Z",
  checks: [
    { name: "Unit tests", state: "failure", url: "https://example.com/run" },
    { name: "Build", state: "success", url: null },
    { name: "Integration", state: "pending", url: null },
  ],
};
describe("CiMark", () => {
  it("hides absent and empty CI", () => {
    expect(renderToStaticMarkup(<CiMark />)).toBe("");
    expect(renderToStaticMarkup(<CiMark ci={{ ...ci, state: "none", checks: [] }} />)).toBe("");
  });
  it("shows the count only when checks disagree, and names the first failure in the tip", () => {
    const mixed = renderToStaticMarkup(<CiMark ci={ci} />);
    expect(mixed).toContain("1/3");
    expect(mixed).toContain('data-tip="CI failing (1 of 3): Unit tests"');
    expect(mixed).toContain("var(--risk)");
    const uniform = renderToStaticMarkup(<CiMark ci={{ ...ci, state: "success", checks: [{ name: "Build", state: "success", url: null }] }} />);
    expect(uniform).toContain('data-tip="CI passing"');
    expect(uniform).not.toMatch(/\d\/\d/);
    expect(uniform).toContain("var(--ok)");
  });
  it.each([["success", "ok"], ["pending", "warn"]] as const)("interactive %s is a closed button", (state, token) => {
    const html = renderToStaticMarkup(<CiMark ci={{ ...ci, state, checks: [{ name: "Build", state, url: null }] }} interactive />);
    expect(html).toContain(`var(--${token})`);
    expect(html).toContain('aria-expanded="false"');
  });
});
