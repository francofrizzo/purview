import { describe, expect, it } from "vitest";
import { sectionInView, visibleDescription } from "./summaryText";

describe("sectionInView", () => {
  it("is the last section whose top has scrolled past, with some slack", () => {
    expect(sectionInView([0, 300, 700], 0)).toBe(0);
    expect(sectionInView([0, 300, 700], 280)).toBe(1);
    expect(sectionInView([0, 300, 700], 900)).toBe(2);
  });
});

describe("visibleDescription", () => {
  it("drops HTML comments GitHub never shows, and trims", () => {
    expect(visibleDescription("<!-- template -->\nReal text.\n<!-- unclosed")).toBe("Real text.");
    expect(visibleDescription(undefined)).toBe("");
    expect(visibleDescription("<!-- only -->")).toBe("");
  });
});
