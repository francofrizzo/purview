import { describe, expect, it } from "vitest";
import { compareVersions, entriesSince, parseChangelog } from "../src/changelog.js";

const MD = `# Changelog

Intro text that is not an entry.

## 2026.10.14.2

- Second of the day.

## 2026.10.14.1
- First of the day, with \`code\`
  and a wrapped line.
* Star bullets too.

## not-a-version

- ignored

## 2026.10.9.3

- Older.
`;

describe("parseChangelog", () => {
  it("reads version headings and their bullets, in document order", () => {
    expect(parseChangelog(MD)).toEqual([
      { version: "2026.10.14.2", date: "2026-10-14", items: ["Second of the day."] },
      {
        version: "2026.10.14.1",
        date: "2026-10-14",
        items: ["First of the day, with `code` and a wrapped line.", "Star bullets too."],
      },
      { version: "2026.10.9.3", date: "2026-10-09", items: ["Older."] },
    ]);
  });
});

describe("compareVersions", () => {
  it("compares segment by segment as numbers", () => {
    expect(compareVersions("2026.10.14.2", "2026.10.14.1")).toBeGreaterThan(0);
    expect(compareVersions("2026.10.9.3", "2026.10.14.1")).toBeLessThan(0);
    expect(compareVersions("2026.10.14.10", "2026.10.14.9")).toBeGreaterThan(0);
    expect(compareVersions("2026.10.14.1", "2026.10.14.1")).toBe(0);
  });
});

describe("entriesSince", () => {
  const entries = parseChangelog(MD);
  it("returns only the newest entry to a reader who has never seen one", () => {
    expect(entriesSince(entries, null).map((e) => e.version)).toEqual(["2026.10.14.2"]);
  });
  it("returns everything newer than the last seen version", () => {
    expect(entriesSince(entries, "2026.10.9.3").map((e) => e.version)).toEqual(["2026.10.14.2", "2026.10.14.1"]);
    expect(entriesSince(entries, "2026.10.14.2")).toEqual([]);
  });
});
