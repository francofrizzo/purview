import { describe, expect, it } from "vitest";
import { prPageTitle, unitFromSearch, withUnitParam } from "./prUrl";
import { UNPLACED_ID } from "./unplaced";

describe("prPageTitle", () => {
  it("leads with repo#number, then the PR title", () => {
    expect(prPageTitle({ repo: "core", number: 8505, title: "Process batches" })).toBe(
      "core#8505 · Process batches · Purview",
    );
    expect(prPageTitle({ repo: "core", number: 1 })).toBe("core#1 · Purview");
  });
});

describe("unit URL param", () => {
  it("round-trips a unit id and keeps other params", () => {
    const s = withUnitParam("?foo=1", "core-batch-update");
    expect(s).toBe("?foo=1&unit=core-batch-update");
    expect(unitFromSearch(s)).toBe("core-batch-update");
  });

  it("spells the pseudo-unit as `unplaced`", () => {
    const s = withUnitParam("", UNPLACED_ID);
    expect(s).toBe("?unit=unplaced");
    expect(unitFromSearch(s)).toBe(UNPLACED_ID);
  });

  it("removes the param for no selection and reads nothing when absent", () => {
    expect(withUnitParam("?unit=x", null)).toBe("");
    expect(unitFromSearch("")).toBeNull();
  });
});
