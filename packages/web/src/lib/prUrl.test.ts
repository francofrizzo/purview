import { describe, expect, it } from "vitest";
import { fileFromSearch, prPageTitle, unitFromSearch, viewFromSearch, withUnitParam, withViewParams } from "./prUrl";
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

describe("view URL params", () => {
  it("round-trips each view, the Files view with its file, and keeps the unit", () => {
    const files = withViewParams("?unit=u1", "files", "src/billing/charge.ts");
    expect(files).toBe("?unit=u1&view=files&file=src%2Fbilling%2Fcharge.ts");
    expect(viewFromSearch(files)).toBe("files");
    expect(fileFromSearch(files)).toBe("src/billing/charge.ts");
    const guide = withViewParams(files, "units", "src/billing/charge.ts");
    expect(guide).toBe("?unit=u1&view=guide");
    expect(viewFromSearch(guide)).toBe("units");
    expect(viewFromSearch(withViewParams(guide, "overview", null))).toBe("overview");
  });

  it("reads nothing from an absent or unknown view", () => {
    expect(viewFromSearch("")).toBeNull();
    expect(viewFromSearch("?view=diff")).toBeNull();
    expect(fileFromSearch("?file=")).toBeNull();
  });
});
