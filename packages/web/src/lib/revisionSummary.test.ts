import { describe, expect, it } from "vitest";
import { formatRevisionSummary, revisionSummaryLines } from "./revisionSummary";

const revisions = [
  { revision: 1 },
  { revision: 2, summary: "timeout moved to shared.go" },
  { revision: 3 },
  { revision: 4, summary: "queue failures mapped in models/communication.go" },
];

describe("revisionSummaryLines", () => {
  it("lists the summarized revisions newest first, skipping the ones without one", () => {
    expect(revisionSummaryLines(revisions)).toEqual([
      { revision: 4, summary: "queue failures mapped in models/communication.go" },
      { revision: 2, summary: "timeout moved to shared.go" },
    ]);
  });

  it("with `after`, keeps only the revisions past it (what landed since a review)", () => {
    expect(revisionSummaryLines(revisions, 2).map((l) => l.revision)).toEqual([4]);
    expect(revisionSummaryLines(revisions, 4)).toEqual([]);
  });

  it("copes with no revisions at all", () => {
    expect(revisionSummaryLines(undefined)).toEqual([]);
  });
});

describe("formatRevisionSummary", () => {
  it("reads rN · summary", () => {
    expect(formatRevisionSummary({ revision: 3, summary: "x" })).toBe("r3 · x");
  });
});
