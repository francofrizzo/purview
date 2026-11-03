import { describe, expect, it } from "vitest";
import { isImportOnlyHunk } from "../src/import-only.js";

/** A hunk from its lines: `+`/`-` ones as written, anything else is context. */
const hunk = (header: string, ...lines: string[]) => ({
  header,
  text: lines.map((l) => (/^[+-]/.test(l) ? l : ` ${l}`)).join("\n") + "\n",
});

describe("isImportOnlyHunk: Go", () => {
  it("takes a hunk inside an import block, named by its header", () => {
    expect(
      isImportOnlyHunk(
        "cmd/main.go",
        hunk(
          "import (",
          '\t"github.com/acme/core/internal/metaagent"',
          '\tdatamodule "github.com/acme/core/internal/metaagent/modules/data"',
          '+\treportsmodule "github.com/acme/core/internal/metaagent/modules/reports"',
          '-\t"github.com/acme/core/pkg/old"',
          ")",
        ),
      ),
    ).toBe(true);
  });

  it("takes a block opened in the hunk's own context, and a single import", () => {
    expect(isImportOnlyHunk("a.go", hunk("package a", "package a", "", "import (", '+\t"fmt"', '\t"os"', ")"))).toBe(true);
    expect(isImportOnlyHunk("a.go", hunk("package a", "package a", "", '+import "fmt"'))).toBe(true);
  });

  it("leaves a blank or dot import to the analysis: it runs for its side effect", () => {
    expect(isImportOnlyHunk("db.go", hunk("import (", '\t"database/sql"', '+\t_ "github.com/lib/pq"'))).toBe(false);
    expect(isImportOnlyHunk("db.go", hunk("import (", '+\t. "github.com/acme/dsl"'))).toBe(false);
  });

  it("never lets a stale header vouch for code past the block", () => {
    expect(
      isImportOnlyHunk("a.go", hunk("import (", ")", "", "var names = []string{", '\t"a",', '+\t"b",', "}")),
    ).toBe(false);
    expect(isImportOnlyHunk("a.go", hunk("import (", '+\t"fmt"', ")", "", "+var x = 1"))).toBe(false);
  });
});

describe("isImportOnlyHunk: TS/JS", () => {
  it("takes import statements, and names inside a long one opened above the hunk", () => {
    expect(
      isImportOnlyHunk(
        "a.tsx",
        hunk("", '-import { useMemo, useState } from "react";', '+import { useId, useMemo, useState } from "react";'),
      ),
    ).toBe(true);
    expect(isImportOnlyHunk("a.ts", hunk("import type {", "  AssistantContactType,", "+  CommunicationChannel,", '} from "./types";'))).toBe(true);
    expect(isImportOnlyHunk("a.ts", hunk("", "+import {", "+  combine,", "+  join,", '+} from "./text";'))).toBe(true);
  });

  it("takes an added re-export, never a removed one", () => {
    expect(isImportOnlyHunk("index.ts", hunk("", 'export * from "./charts";', '+export * from "./probe";'))).toBe(true);
    expect(isImportOnlyHunk("index.ts", hunk("", '-export * from "./charts";'))).toBe(false);
    expect(isImportOnlyHunk("index.ts", hunk("export {", "  a,", "-  b,", '} from "./x";'))).toBe(false);
  });

  it("leaves a bare import and a local export list to the analysis", () => {
    expect(isImportOnlyHunk("main.ts", hunk("", '+import "./polyfill";'))).toBe(false);
    expect(isImportOnlyHunk("a.ts", hunk("", "export {", "  a,", "+  b,", "};"))).toBe(false);
  });

  it("refuses names that turn out not to be in an import", () => {
    expect(isImportOnlyHunk("a.ts", hunk("import {", '} from "x";', "", "const list = [", "  a,", "+  b,", "];"))).toBe(false);
    expect(isImportOnlyHunk("a.ts", hunk("", '+import { a } from "a";', "+const b = a();"))).toBe(false);
  });
});

describe("isImportOnlyHunk: Python and the rest", () => {
  it("takes import lines and a parenthesized from-import", () => {
    expect(isImportOnlyHunk("a.py", hunk("", "import os", "+import sys"))).toBe(true);
    expect(isImportOnlyHunk("a.py", hunk("from app.models import (", "    User,", "+    Team,", ")"))).toBe(true);
  });

  it("leaves __future__ alone", () => {
    expect(isImportOnlyHunk("a.py", hunk("", "+from __future__ import annotations"))).toBe(false);
  });

  it("never claims a language it does not know, or a hunk with nothing changed", () => {
    expect(isImportOnlyHunk("a.rs", hunk("", "+use std::io;"))).toBe(false);
    expect(isImportOnlyHunk("Makefile", hunk("", "+import x"))).toBe(false);
    expect(isImportOnlyHunk("a.go", hunk("import (", "+", '\t"fmt"'))).toBe(false);
  });
});
