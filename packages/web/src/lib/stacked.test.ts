import { describe, expect, it } from "vitest";
import { stackedOnLink } from "./stacked";

const meta = {
  host: "github.com",
  owner: "primo-devs",
  repo: "core",
  baseRef: "codex/deuda",
  basePr: { number: 8501, title: "Deuda", url: "https://github.com/primo-devs/core/pull/8501" },
};

describe("stackedOnLink", () => {
  it("links inside Purview when the base PR is tracked", () => {
    expect(stackedOnLink(meta, true)).toEqual({
      label: "stacked on #8501",
      href: "/pr/github.com/primo-devs/core/8501",
      internal: true,
      title: 'Targets codex/deuda, the head of #8501 "Deuda"',
    });
  });

  it("links to GitHub otherwise", () => {
    const link = stackedOnLink(meta, false);
    expect(link?.href).toBe("https://github.com/primo-devs/core/pull/8501");
    expect(link?.internal).toBe(false);
    expect(link?.title).toContain("opens on GitHub");
  });

  it("is null for a PR that is not stacked on a known PR", () => {
    expect(stackedOnLink({ ...meta, basePr: null }, false)).toBeNull();
    expect(stackedOnLink({ ...meta, basePr: undefined }, true)).toBeNull();
  });
});
