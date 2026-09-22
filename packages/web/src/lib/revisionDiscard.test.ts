import { describe, expect, it } from "vitest";
import { discardAvailability, discardConfirmText } from "./revisionDiscard";

const revisions = [{ revision: 1 }, { revision: 2 }, { revision: 4 }];

describe("discardAvailability", () => {
  it("falls back to the newest revision on record below the current one", () => {
    // r3 was discarded earlier: it is gone from the list, so r4 falls back to r2.
    expect(discardAvailability({ revision: 4, revisions }, false)).toEqual({
      previous: 2,
      blockedWhy: null,
    });
  });

  it("offers nothing on the only revision", () => {
    expect(discardAvailability({ revision: 1, revisions: [{ revision: 1 }] }, false)).toEqual({
      previous: null,
      blockedWhy: null,
    });
    expect(discardAvailability({ revision: 1 }, true).previous).toBeNull();
  });

  it("holds the action back while an analysis is live", () => {
    const res = discardAvailability({ revision: 4, revisions }, true);
    expect(res.previous).toBe(2);
    expect(res.blockedWhy).toMatch(/analysis is running/);
  });
});

describe("discardConfirmText", () => {
  it("names both revisions and says a refresh may record the head again", () => {
    const text = discardConfirmText(4, 2);
    expect(text).toMatch(/^Discard r4\?/);
    expect(text).toContain("compares against r2");
    expect(text).toContain("records it again");
  });
});
