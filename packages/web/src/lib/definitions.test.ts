import { describe, expect, it } from "vitest";
import type { FilesJson, Hunk } from "../api/types";
import { findDiffLocalDefinitions, findInDiffHunk } from "./definitions";

function hunk(id: string, newStart: number, newLines: number): Hunk {
  return {
    id,
    file: "src/widgets.ts",
    oldStart: 1,
    oldLines: 1,
    newStart,
    newLines,
    header: "",
  };
}

function filesJson(): FilesJson {
  return {
    files: [
      {
        path: "src/widgets.ts",
        hunks: [hunk("h1", 10, 5), hunk("h2", 30, 0)],
      },
      { path: "src/other.ts", hunks: [hunk("h3", 1, 10)] },
    ],
  };
}

describe("findInDiffHunk", () => {
  it("finds the hunk whose new-side range contains the line", () => {
    expect(findInDiffHunk(filesJson(), "src/widgets.ts", 12)).toEqual({
      hunkId: "h1",
      path: "src/widgets.ts",
    });
  });

  it("matches the range boundaries inclusively/exclusively (start in, end out)", () => {
    expect(findInDiffHunk(filesJson(), "src/widgets.ts", 10)).toEqual({
      hunkId: "h1",
      path: "src/widgets.ts",
    });
    expect(findInDiffHunk(filesJson(), "src/widgets.ts", 15)).toBeNull();
  });

  it("returns null for a file not in the diff", () => {
    expect(findInDiffHunk(filesJson(), "src/missing.ts", 12)).toBeNull();
  });

  it("returns null for a line outside every hunk of a changed file", () => {
    expect(findInDiffHunk(filesJson(), "src/widgets.ts", 1)).toBeNull();
  });

  it("skips a pure-deletion hunk (newLines 0) rather than matching every line", () => {
    expect(findInDiffHunk(filesJson(), "src/widgets.ts", 30)).toBeNull();
  });
});

describe("findDiffLocalDefinitions", () => {
  const withAdded = (added: string[]): FilesJson => ({
    files: [
      {
        path: "browser/types.go",
        hunks: [{ ...hunk("g1", 10, added.length), addedLines: added } as Hunk],
      },
    ],
  });

  it("finds a Go type the PR itself introduces", () => {
    const files = withAdded([
      "// BrowserServiceEnvironment names one deployment of a service.",
      "type BrowserServiceEnvironment string",
      'BrowserServiceEnvironmentTest BrowserServiceEnvironment = "test"',
    ]);
    expect(findDiffLocalDefinitions(files, "BrowserServiceEnvironment")).toEqual([
      {
        hunkId: "g1",
        path: "browser/types.go",
        lineText: "type BrowserServiceEnvironment string",
        addedIndex: 1,
      },
    ]);
  });

  it("does not treat a mere usage as a definition", () => {
    const files = withAdded(["result := computeTotal(items)", "return computeTotal(items)"]);
    expect(findDiffLocalDefinitions(files, "computeTotal")).toEqual([]);
  });

  it("requires the defined name itself, not a prefix-sharing sibling", () => {
    const files = withAdded(["func computeTotals() int {"]);
    expect(findDiffLocalDefinitions(files, "computeTotal")).toEqual([]);
  });

  it("finds a method definition behind a Go receiver", () => {
    const files = withAdded(["func (s *Server) Close() error {"]);
    expect(findDiffLocalDefinitions(files, "Close")).toEqual([
      {
        hunkId: "g1",
        path: "browser/types.go",
        lineText: "func (s *Server) Close() error {",
        addedIndex: 0,
      },
    ]);
  });
});
