import { describe, expect, it } from "vitest";
import { formatImportResult } from "./reviewImport";

describe("formatImportResult", () => {
  it("reports just the imported count when nothing else happened", () => {
    expect(formatImportResult({ imported: ["a"], alreadyTracked: [], failed: [], days: 7 })).toBe(
      "imported 1",
    );
  });

  it("adds already-tracked and failed counts when present", () => {
    expect(
      formatImportResult({
        imported: ["a", "b"],
        alreadyTracked: ["c"],
        failed: [{ key: "d", error: "boom" }],
        days: 7,
      }),
    ).toBe("imported 2 · 1 already tracked · 1 failed");
  });

  it("reports zero imported without pluralizing or hiding the count", () => {
    expect(
      formatImportResult({ imported: [], alreadyTracked: ["a"], failed: [], days: 7 }),
    ).toBe("imported 0 · 1 already tracked");
  });
});
