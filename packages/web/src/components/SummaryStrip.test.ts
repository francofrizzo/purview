import { describe, expect, it } from "vitest";
import { summaryLede, visibleDescription } from "./SummaryStrip";

describe("summaryLede", () => {
  it("strips emphasis but keeps underscores inside words", () => {
    expect(summaryLede("The **ART** get_balance tool answers from _the_ statement. More.")).toBe(
      "The ART get_balance tool answers from the statement.",
    );
  });
});

describe("visibleDescription", () => {
  it("drops HTML comments GitHub never shows, and trims", () => {
    expect(visibleDescription("<!-- template -->\nReal text.\n<!-- unclosed")).toBe("Real text.");
    expect(visibleDescription(undefined)).toBe("");
    expect(visibleDescription("<!-- only -->")).toBe("");
  });
});
