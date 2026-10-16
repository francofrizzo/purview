import { describe, expect, it } from "vitest";
import { summaryLede, summaryLedeMarkdown, visibleDescription } from "./SummaryStrip";

describe("summaryLede", () => {
  it("strips emphasis but keeps underscores inside words", () => {
    expect(summaryLede("The **ART** get_balance tool answers from _the_ statement. More.")).toBe(
      "The ART get_balance tool answers from the statement.",
    );
  });
});

describe("summaryLedeMarkdown", () => {
  it("keeps inline marks, drops block structure, and ends the sentence past a closing mark", () => {
    expect(summaryLedeMarkdown("- Pins each call to `charge()` via **the ledger.** Then more.")).toBe(
      "Pins each call to `charge()` via **the ledger.**",
    );
    expect(summaryLedeMarkdown("```js\nx\n```\nThe first sentence. Second sentence here.")).toBe(
      "The first sentence.",
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
