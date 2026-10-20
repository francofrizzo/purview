import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CiChip, CiMark } from "./Chips";
import type { Ci } from "../api/types";

const ci: Ci = {
  state: "failure", headSha: "head", checkedAt: "2026-10-20T12:00:00Z",
  checks: [
    { name: "Unit tests", state: "failure", url: "https://example.com/run" },
    { name: "Build", state: "success", url: null },
    { name: "Integration", state: "pending", url: null },
  ],
};
describe("CiChip", () => {
  it("hides absent and empty CI", () => {
    expect(renderToStaticMarkup(<CiChip />)).toBe("");
    expect(renderToStaticMarkup(<CiChip ci={{ ...ci, state: "none", checks: [] }} />)).toBe("");
  });
  it("counts checks in the rollup state and names the first failure", () => {
    const html = renderToStaticMarkup(<CiChip ci={ci} />);
    expect(html).toContain("failing · 1 of 3");
    expect(html).toContain('title="Unit tests"');
    expect(html).toContain("var(--risk-soft)");
  });
  it.each([["success", "passing", "ok"], ["pending", "pending", "warn"]] as const)("renders uniform %s without a count", (state, label, token) => {
    const html = renderToStaticMarkup(<CiChip ci={{ ...ci, state, checks: [{ name: "Build", state, url: null }] }} interactive />);
    expect(html).toContain(label);
    expect(html).not.toContain(" of ");
    expect(html).toContain(`var(--${token}-soft)`);
    expect(html).toContain('aria-expanded="false"');
  });
  it("marks a row with the icon and a count only when checks disagree", () => {
    const mixed = renderToStaticMarkup(<CiMark ci={ci} />);
    expect(mixed).toContain("1/3");
    expect(mixed).toContain('data-tip="CI failing (1 of 3): Unit tests"');
    expect(mixed).not.toContain("failing ·");
    const uniform = renderToStaticMarkup(<CiMark ci={{ ...ci, state: "success", checks: [{ name: "Build", state: "success", url: null }] }} />);
    expect(uniform).toContain('data-tip="CI passing"');
    expect(uniform).not.toMatch(/\d\/\d/);
    expect(renderToStaticMarkup(<CiMark />)).toBe("");
  });
});
