import { describe, expect, it } from "vitest";
import type { FilesJson, Hunk } from "../api/types";
import { buildDefinitionIndex, findDiffLocalDefinitions } from "./definitions";

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

describe("buildDefinitionIndex", () => {
  const withAdded = (path: string, hunkId: string, added: string[]): FilesJson["files"][number] => ({
    path,
    hunks: [{ ...hunk(hunkId, 10, added.length), addedLines: added } as Hunk],
  });

  it("is empty for a diff with no definitions", () => {
    const files: FilesJson = {
      files: [withAdded("src/widgets.ts", "h1", ["result := computeTotal(items)"])],
    };
    expect(buildDefinitionIndex(files)).toEqual(new Map());
  });

  it("maps a name to every one of its definitions, in document order", () => {
    const files: FilesJson = {
      files: [
        withAdded("src/widgets.ts", "h1", [
          "function widget() {",
          "class widget {", // a shadowing re-declaration further down the same hunk
        ]),
      ],
    };
    expect(buildDefinitionIndex(files).get("widget")).toEqual([
      { hunkId: "h1", path: "src/widgets.ts", lineText: "function widget() {", addedIndex: 0 },
      { hunkId: "h1", path: "src/widgets.ts", lineText: "class widget {", addedIndex: 1 },
    ]);
  });

  it("collects definitions of different names from several files under one index", () => {
    const files: FilesJson = {
      files: [
        withAdded("src/a.ts", "h1", ["export function alpha() {"]),
        withAdded("src/b.ts", "h2", ["export function beta() {"]),
      ],
    };
    const index = buildDefinitionIndex(files);
    expect(index.get("alpha")).toEqual([
      { hunkId: "h1", path: "src/a.ts", lineText: "export function alpha() {", addedIndex: 0 },
    ]);
    expect(index.get("beta")).toEqual([
      { hunkId: "h2", path: "src/b.ts", lineText: "export function beta() {", addedIndex: 0 },
    ]);
    expect(index.size).toBe(2);
  });
});
