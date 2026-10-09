import { describe, expect, it } from "vitest";
import type { FileEntry, ReviewUnit } from "../api/types";
import {
  generatedReason,
  generatedTag,
  generatedToggle,
  generatedUnitFiles,
  parsePatternLines,
  reviewProgress,
  workUnits,
} from "./generated";

const file = (path: string, hunkIds: string[], over: Partial<FileEntry> = {}): FileEntry => ({
  path,
  additions: 3,
  deletions: 1,
  hunks: hunkIds.map((id) => ({
    id,
    file: path,
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    header: "@@",
  })),
  ...over,
});

describe("workUnits", () => {
  it("drops only the generated unit", () => {
    const units = [{ id: "a" }, { id: "generated", origin: "generated" as const }, { id: "b" }];
    expect(workUnits(units).map((u) => u.id)).toEqual(["a", "b"]);
  });
});

describe("generatedTag / generatedReason", () => {
  it("tags lockfiles as lock and every other source as gen", () => {
    expect(generatedTag({ source: "lockfile" })).toBe("lock");
    for (const source of ["repo", "gitattributes", "path", "marker"] as const) {
      expect(generatedTag({ source })).toBe("gen");
    }
  });

  it("names the signal and its detail", () => {
    expect(generatedReason({ source: "gitattributes", detail: "src/api/*.d.ts" })).toBe(
      "Generated: marked linguist-generated in .gitattributes (src/api/*.d.ts). Skipped by the analysis.",
    );
    expect(generatedReason({ source: "lockfile" })).toBe("Lockfile: a lockfile. Skipped by the analysis.");
  });

  it("leaves out an empty detail", () => {
    expect(generatedReason({ source: "marker", detail: "  " })).toBe(
      "Generated: carries a generated-code marker. Skipped by the analysis.",
    );
  });
});

describe("parsePatternLines", () => {
  it("trims, drops blanks and de-duplicates, keeping order", () => {
    expect(parsePatternLines("  gen/**\n\n*.pb.go\ngen/**\n   \n")).toEqual(["gen/**", "*.pb.go"]);
  });

  it("reads an empty textarea as no patterns", () => {
    expect(parsePatternLines("")).toEqual([]);
  });
});

describe("generatedUnitFiles", () => {
  const files = [
    file("src/a.ts", ["h1"]),
    file("pnpm-lock.yaml", ["h2", "h3"], { additions: 120, deletions: 40, generated: { source: "lockfile" } }),
    file("gen/x.pb.go", ["h4"], { generated: { source: "path", detail: "*.pb.go" } }),
  ];

  it("lists the unit's files once each, in file order, with their stats", () => {
    const unit = { hunkIds: ["h4", "h3", "h2"] } as Pick<ReviewUnit, "hunkIds">;
    expect(generatedUnitFiles(files, unit)).toEqual([
      { path: "pnpm-lock.yaml", additions: 120, deletions: 40, generated: { source: "lockfile" } },
      { path: "gen/x.pb.go", additions: 3, deletions: 1, generated: { source: "path", detail: "*.pb.go" } },
    ]);
  });

  it("is empty for a unit holding nothing in this revision", () => {
    expect(generatedUnitFiles(files, { hunkIds: ["gone"] })).toEqual([]);
  });
});

describe("generatedToggle", () => {
  it("offers to un-mark a generated file, and says it sticks for the repo", () => {
    const t = generatedToggle({ generated: { source: "path" } }, "acme/billing");
    expect(t.generated).toBe(false);
    expect(t.label).toBe("Not generated");
    expect(t.explain).toContain("every PR in acme/billing");
    expect(t.explain).toContain("never treat as generated");
  });

  it("offers to mark any other file", () => {
    const t = generatedToggle({}, "acme/billing");
    expect(t.generated).toBe(true);
    expect(t.label).toBe("Treat as generated");
    expect(t.explain).toContain("always treat as generated");
  });
});

describe("reviewProgress", () => {
  it("counts every hunk but those of generated files", () => {
    const files = [
      file("src/a.ts", ["a1", "a2"]),
      file("pnpm-lock.yaml", ["l1"], { generated: { source: "lockfile" } }),
    ];
    expect(reviewProgress(files, { a1: { viewed: true }, l1: { viewed: true } })).toEqual({
      viewed: 1,
      total: 2,
    });
  });
});
