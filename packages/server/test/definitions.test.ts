import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { updateMeta } from "@reviewer/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFINITION_GREP_PATTERNS,
  buildTagIndex,
  clearDefinitionIndexCache,
  isUniversalCtagsAvailable,
  parseCtagsJson,
  parseGitGrepOutput,
  resetCtagsAvailabilityCache,
  resolveDefinition,
} from "../src/definitions.js";
import { buildFixture, key } from "./fixtures.js";
import { git, makeRepo } from "./git-fixtures.js";

let dir: string;
let root: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-defs-"));
  root = path.join(dir, "state");
  fs.mkdirSync(root, { recursive: true });
});

afterEach(() => {
  clearDefinitionIndexCache();
  resetCtagsAvailabilityCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("parseCtagsJson", () => {
  it("parses tag lines and skips the trailing summary object", () => {
    const output = [
      JSON.stringify({
        _type: "tag",
        name: "Close",
        path: "./server/server.go",
        line: 42,
        kind: "method",
      }),
      JSON.stringify({
        _type: "tag",
        name: "Close",
        path: "client/client.go",
        line: 8,
        kind: "func",
      }),
      // The summary object ctags appends at the end — must be ignored.
      JSON.stringify({ _type: "ctags", _version: "6.1.0" }),
      "", // trailing newline
    ].join("\n");

    const entries = parseCtagsJson(output);
    expect(entries).toEqual([
      { name: "Close", path: "server/server.go", line: 42, kind: "method" },
      { name: "Close", path: "client/client.go", line: 8, kind: "func" },
    ]);
  });

  it("skips malformed or incomplete lines rather than throwing", () => {
    const output = [
      "not json at all",
      JSON.stringify({ _type: "tag", name: "onlyName" }), // missing path/line
      JSON.stringify({ _type: "tag", name: "Ok", path: "a.ts", line: 3 }),
    ].join("\n");
    expect(parseCtagsJson(output)).toEqual([{ name: "Ok", path: "a.ts", line: 3 }]);
  });
});

describe("buildTagIndex", () => {
  it("groups entries by name, preserving emission order", () => {
    const index = buildTagIndex([
      { name: "Close", path: "a.go", line: 1 },
      { name: "Open", path: "b.go", line: 2 },
      { name: "Close", path: "c.go", line: 3 },
    ]);
    expect(index.get("Close")?.map((e) => e.path)).toEqual(["a.go", "c.go"]);
    expect(index.get("Open")?.map((e) => e.path)).toEqual(["b.go"]);
    expect(index.get("Missing")).toBeUndefined();
  });
});

describe("parseGitGrepOutput", () => {
  it("splits path:line:content, keeping later colons inside content", () => {
    const output = [
      "src/server.go:42:func (s *Server) Close() error {",
      "src/routes.ts:7:const url = \"http://x:8080/a:b\";",
    ].join("\n");
    expect(parseGitGrepOutput(output)).toEqual([
      { path: "src/server.go", line: 42, lineText: "func (s *Server) Close() error {" },
      { path: "src/routes.ts", line: 7, lineText: 'const url = "http://x:8080/a:b";' },
    ]);
  });

  it("ignores lines with no parseable path:line prefix", () => {
    expect(parseGitGrepOutput("garbage\n\nsrc/a.ts:1:ok")).toEqual([
      { path: "src/a.ts", line: 1, lineText: "ok" },
    ]);
  });
});

/** Build a matcher the same way definitions.ts does, for a fixed symbol. */
function matcherFor(symbol: string): RegExp[] {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return DEFINITION_GREP_PATTERNS.map((p) => new RegExp(p.replace(/NAME/g, escaped)));
}

describe("DEFINITION_GREP_PATTERNS", () => {
  const matches = (symbol: string, line: string) => matcherFor(symbol).some((re) => re.test(line));

  it("matches common definition shapes", () => {
    expect(matches("Close", "func (s *Server) Close() error {")).toBe(true);
    expect(matches("fetchWidgets", "export async function fetchWidgets(id: string) {")).toBe(true);
    expect(matches("Widget", "export class Widget {")).toBe(true);
    expect(matches("Config", "export interface Config {")).toBe(true);
    expect(matches("rate", "export const rate = 0.1;")).toBe(true);
    expect(matches("load_config", "def load_config(path):")).toBe(true);
    expect(matches("Server", "type Server struct {")).toBe(true);
    expect(matches("parse", "fn parse(input: &str) -> Result<Ast> {")).toBe(true);
  });

  it("does not match Go's short variable declaration for the same name", () => {
    // `x := foo()` looks like a definition of `x` but is a local assignment,
    // not something a "go to definition" should ever land on.
    expect(matches("x", "x := foo()")).toBe(false);
  });

  it("does not match an unrelated call site", () => {
    expect(matches("Close", "conn.Close()")).toBe(false);
  });
});

describe("resolveDefinition", () => {
  it("reports no checkout when the PR has none configured", async () => {
    buildFixture(root);
    const result = await resolveDefinition(key, "fetchWidgets", root);
    expect(result).toEqual({ checkout: false, reason: expect.any(String) });
  });

  it("finds a grep-fallback candidate with a snippet in a real checkout", async () => {
    buildFixture(root);
    const repo = makeRepo(path.join(dir, "repo"), { origin: false });
    const lines = Array.from({ length: 5 }, (_, i) => `// padding ${i}`);
    lines.push("export function fetchWidgets(id: string) {");
    lines.push("  return db.widgets.find(id);");
    lines.push("}");
    fs.mkdirSync(path.join(repo.path, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo.path, "src", "widgets.ts"), lines.join("\n") + "\n");
    git(["add", "."], repo.path);
    git(["commit", "-q", "-m", "add widgets"], repo.path);

    updateMeta(key, { repoPath: repo.path }, root);

    const result = await resolveDefinition(key, "fetchWidgets", root);
    expect(result.checkout).toBe(true);
    if (!result.checkout) throw new Error("unreachable");
    // Whichever engine this machine has on PATH, it must find the definition.
    expect(result.engine).toBe((await isUniversalCtagsAvailable()) ? "ctags" : "grep");
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0];
    expect(candidate.path).toBe("src/widgets.ts");
    expect(candidate.line).toBe(6);
    expect(candidate.snippet.lines.join("\n")).toContain("fetchWidgets");
    expect(candidate.snippet.startLine).toBeGreaterThanOrEqual(1);
  });

  it("returns no candidates (not an error) when nothing matches", async () => {
    buildFixture(root);
    const repo = makeRepo(path.join(dir, "repo2"), { origin: false });
    updateMeta(key, { repoPath: repo.path }, root);
    const result = await resolveDefinition(key, "totallyMissingSymbol", root);
    expect(result).toEqual({
      checkout: true,
      engine: (await isUniversalCtagsAvailable()) ? "ctags" : "grep",
      candidates: [],
    });
  });
});
