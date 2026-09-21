import { describe, expect, it } from "vitest";
import { computeHunkId } from "../src/hunk-id.js";
import { renderTriage } from "../src/triage.js";
import type { FileDiff, FilesJson, Hunk } from "../src/schemas.js";

function mkHunk(
  file: string,
  added: string[],
  removed: string[],
  overrides: Partial<Hunk> = {},
): Hunk {
  return {
    id: overrides.id ?? computeHunkId(file, added, removed),
    file,
    oldStart: 1,
    oldLines: removed.length,
    newStart: 1,
    newLines: added.length,
    header: "func example()",
    addedLines: added,
    removedLines: removed,
    text: [...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join("\n"),
    ...overrides,
  };
}

function filesJson(files: FileDiff[], revision = 1): FilesJson {
  return { revision, files };
}

describe("renderTriage", () => {
  it("prints a header line, one line per file, one per hunk, in files.json order", () => {
    const h1 = mkHunk("src/a.ts", ["x"], ["y"]);
    const h2 = mkHunk("src/b.ts", ["z"], []);
    const out = renderTriage(
      filesJson([
        { path: "src/a.ts", status: "modified", binary: false, hunks: [h1] },
        { path: "src/b.ts", status: "modified", binary: false, hunks: [h2] },
      ]),
    );
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^revision 1 {3}2 files {3}2 hunks {3}\+2 -1$/);
    expect(out).toContain("src/a.ts   modified   1 hunk   +1 -1");
    expect(out).toContain(`  ${h1.id}   +1 -1   @@ func example()`);
    expect(out).toContain("src/b.ts   modified   1 hunk   +1 -0");
  });

  it("prints the bodies: line with the CLI command and key when given", () => {
    const out = renderTriage(filesJson([]), { cliCommand: "node cli.js", key: "gh/o/r/1" });
    expect(out).toContain("bodies: node cli.js show gh/o/r/1 <hunk-id|path|'glob'>...");
    // zsh fails an unquoted glob that matches no local file before the CLI runs.
    expect(out).toContain("single-quote globs, e.g. 'internal/**/*_test.go'");
  });

  it("shows renamed files as old -> new", () => {
    const h = mkHunk("new/name.ts", ["a"], []);
    const out = renderTriage(
      filesJson([
        { path: "new/name.ts", oldPath: "old/name.ts", status: "renamed", binary: false, hunks: [h] },
      ]),
    );
    expect(out).toContain("old/name.ts -> new/name.ts   renamed   1 hunk");
  });

  it("prints binary files as one line with no hunks", () => {
    const out = renderTriage(
      filesJson([{ path: "assets/logo.png", status: "added", binary: true, hunks: [] }]),
    );
    expect(out).toContain("assets/logo.png   added   binary");
  });

  it("truncates long headers to ~60 chars", () => {
    const longHeader = "func " + "veryLongFunctionNameThatGoesOnAndOnAndOnAndOn".repeat(2) + "()";
    const h = mkHunk("src/a.ts", ["x"], [], { header: longHeader });
    const out = renderTriage(filesJson([{ path: "src/a.ts", status: "modified", binary: false, hunks: [h] }]));
    const hunkLine = out.split("\n").find((l) => l.includes(h.id))!;
    // "  <id>   +1 -0   @@ " prefix plus at most 60 chars of header plus an
    // ellipsis; well short of the full header length.
    expect(hunkLine.length).toBeLessThan(longHeader.length);
    expect(hunkLine).toContain("…");
  });

  describe("hints", () => {
    it("flags lockfiles", () => {
      const h = mkHunk("pnpm-lock.yaml", ["a"], []);
      const out = renderTriage(
        filesJson([{ path: "pnpm-lock.yaml", status: "modified", binary: false, hunks: [h] }]),
      );
      expect(out).toContain("pnpm-lock.yaml   modified   1 hunk   +1 -0   lock");
    });

    it("flags generated files by path", () => {
      const h = mkHunk("api/thing.pb.go", ["a"], []);
      const out = renderTriage(
        filesJson([{ path: "api/thing.pb.go", status: "modified", binary: false, hunks: [h] }]),
      );
      expect(out).toContain("gen");
    });

    it("does not flag sqlc query sources as generated", () => {
      const p = "internal/storage/sqlc/queries/email_assistant.sql";
      const h = mkHunk(p, ["SELECT 1;"], []);
      const out = renderTriage(filesJson([{ path: p, status: "modified", binary: false, hunks: [h] }]));
      expect(out).toContain(`${p}   modified   1 hunk   +1 -0\n`);
      expect(out.split("\n").find((l) => l.includes(h.id))).not.toContain("gen");
    });

    it("flags sqlc outputs as generated", () => {
      for (const p of [
        "internal/storage/sqlc/email_assistant.sql.go",
        "internal/storage/sqlc/models.go",
        "internal/storage/sqlc/db.go",
        "internal/storage/sqlc/querier.go",
      ]) {
        const h = mkHunk(p, ["a"], []);
        const out = renderTriage(filesJson([{ path: p, status: "modified", binary: false, hunks: [h] }]));
        expect(out).toContain(`${p}   modified   1 hunk   +1 -0   gen`);
      }
      // Other Go files next to them are hand-written.
      const p = "internal/storage/sqlc/helpers.go";
      const out = renderTriage(
        filesJson([{ path: p, status: "modified", binary: false, hunks: [mkHunk(p, ["a"], [])] }]),
      );
      expect(out).toContain(`${p}   modified   1 hunk   +1 -0\n`);
    });

    it("still flags a .sql hunk carrying a generated marker", () => {
      const p = "db/schema.sql";
      const h = mkHunk(p, ["a"], [], { text: "+-- Code generated by tool. DO NOT EDIT.\n" });
      const out = renderTriage(filesJson([{ path: p, status: "modified", binary: false, hunks: [h] }]));
      expect(out.split("\n").find((l) => l.includes(h.id))).toContain("gen");
    });

    it("flags generated hunks by text, on the hunk line", () => {
      const h = mkHunk("src/a.ts", ["a"], [], { text: "+// Code generated by tool. DO NOT EDIT.\n" });
      const out = renderTriage(filesJson([{ path: "src/a.ts", status: "modified", binary: false, hunks: [h] }]));
      const hunkLine = out.split("\n").find((l) => l.includes(h.id))!;
      expect(hunkLine).toContain("gen");
      // it's a hunk-line hint, not a file-line hint
      expect(out).not.toContain("src/a.ts   modified   1 hunk   +1 -0   gen");
    });

    it("flags docs, tests, snap and mig paths", () => {
      const cases: [string, string][] = [
        ["docs/readme.md", "docs"],
        ["pkg/foo_test.go", "tests"],
        ["pkg/__snapshots__/x.snap", "snap"],
        ["migrations/0001_init.sql", "mig"],
      ];
      for (const [p, hint] of cases) {
        const h = mkHunk(p, ["a"], []);
        const out = renderTriage(filesJson([{ path: p, status: "modified", binary: false, hunks: [h] }]));
        const line = out.split("\n").find((l) => l.startsWith(p))!;
        expect(line, `${p} should carry hint ${hint}`).toContain(hint);
      }
    });
  });

  describe("moved code", () => {
    const BLOCK = [
      "func computeTotal(items []Item) int {",
      "  total := 0",
      "  for _, it := range items {",
      "    total += it.Price",
      "  }",
      "  return total",
      "}",
    ];

    it("marks mv-out / mv-in hunk lines and lists pairs under MOVED", () => {
      const hOut = mkHunk("a.go", [], BLOCK);
      const hIn = mkHunk("b.go", BLOCK, []);
      const out = renderTriage(
        filesJson([
          { path: "a.go", status: "modified", binary: false, hunks: [hOut] },
          { path: "b.go", status: "modified", binary: false, hunks: [hIn] },
        ]),
      );
      const outLine = out.split("\n").find((l) => l.includes(hOut.id))!;
      const inLine = out.split("\n").find((l) => l.includes(hIn.id))!;
      expect(outLine).toContain(`mv-out ${BLOCK.length}/${BLOCK.length} to b.go`);
      expect(inLine).toContain(`mv-in ${BLOCK.length}/${BLOCK.length} from a.go`);
      expect(out).toContain("MOVED");
      expect(out).toContain(`~${BLOCK.length} lines moved: a.go -> b.go`);
    });

    it("marks a partial move as N lines (not N/N) when not the whole hunk", () => {
      const hOut = mkHunk("a.go", [], [...BLOCK, "var unrelated = 1"]);
      const hIn = mkHunk("b.go", BLOCK, []);
      const out = renderTriage(
        filesJson([
          { path: "a.go", status: "modified", binary: false, hunks: [hOut] },
          { path: "b.go", status: "modified", binary: false, hunks: [hIn] },
        ]),
      );
      const outLine = out.split("\n").find((l) => l.includes(hOut.id))!;
      expect(outLine).toContain(`mv-out ${BLOCK.length} lines to b.go`);
    });
  });
});
