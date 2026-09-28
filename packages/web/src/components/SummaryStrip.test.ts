import { describe, expect, it } from "vitest";
import { summaryLede } from "./SummaryStrip";

describe("summaryLede", () => {
  it("strips emphasis but keeps underscores inside words", () => {
    expect(summaryLede("The **ART** get_balance tool answers from _the_ statement. More.")).toBe(
      "The ART get_balance tool answers from the statement.",
    );
  });
});
