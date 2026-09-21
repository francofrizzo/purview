import { describe, expect, it } from "vitest";
import { changelogHeading, changelogView, formatChangelogEntry } from "./changelog";
import { mockDetail } from "../mocks/fixture";

describe("changelogView", () => {
  it("shows nothing without entries", () => {
    expect(changelogView(undefined)).toBeNull();
    expect(changelogView([])).toBeNull();
  });

  it("puts the newest entry first and lists the rest newest first", () => {
    const view = changelogView([
      { revision: 2, text: "two" },
      { revision: 4, text: "four" },
      { revision: 3, text: "three" },
    ]);
    expect(view!.latest).toEqual({ revision: 4, text: "four" });
    expect(view!.earlier.map((e) => e.revision)).toEqual([3, 2]);
  });

  it("formats an entry as r<n> · text", () => {
    expect(formatChangelogEntry({ revision: 3, text: "added a .5 test" })).toBe("r3 · added a .5 test");
  });

  it("the mock fixture has a unit with a two-entry changelog", () => {
    const unit = mockDetail.state.units.find((u) => (u.changelog?.length ?? 0) === 2);
    expect(unit).toBeDefined();
    expect(changelogView(unit!.changelog)!.earlier).toHaveLength(1);
  });
});

describe("changelogHeading", () => {
  it("counts revisions with the right plural", () => {
    expect(changelogHeading(1)).toBe("Changelog (1 revision)");
    expect(changelogHeading(3)).toBe("Changelog (3 revisions)");
  });
});
