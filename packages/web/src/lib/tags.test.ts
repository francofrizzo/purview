import { expect, it } from "vitest";
import { normalizeTag, tagSlot } from "./tags";
it("assigns stable, distinct sample slots", () => {
  expect(tagSlot("payments")).toBe(tagSlot("payments"));
  expect(tagSlot("payments")).not.toBe(tagSlot("cleanup"));
  for (const tag of ["payments", "cleanup", "á"]) {
    expect(tagSlot(tag)).toBeGreaterThanOrEqual(0);
    expect(tagSlot(tag)).toBeLessThan(8);
  }
});
it("normalizes whitespace and case", () => expect(normalizeTag("  Release \n ONE ")).toBe("release one"));
