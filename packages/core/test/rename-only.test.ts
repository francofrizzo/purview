import { describe, expect, it } from "vitest";
import { renameOnlyHunks } from "../src/rename-only.js";
import type { FileDiff } from "../src/schemas.js";

let n = 0;
/** A file from hunks given as lines: `+`/`-` ones as written, anything else is context. */
const file = (path: string, ...hunks: string[][]): FileDiff => ({
  path,
  status: "modified",
  binary: false,
  hunks: hunks.map((lines) => ({
    id: `h${++n}`,
    file: path,
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    header: "",
    addedLines: [],
    removedLines: [],
    text: lines.map((l) => (/^[+-]/.test(l) ? l : ` ${l}`)).join("\n") + "\n",
  })),
});
const ids = (files: FileDiff[]) => [...renameOnlyHunks(files).keys()];

describe("renameOnlyHunks", () => {
  it("tags a rename carried through code, comments and docs, naming the changed words", () => {
    const files = [
      file("a.go", ["func run() {", "-\tc := NewUniversalChatbot(cfg) // the universal one", "+\tc := NewContactlessChatbot(cfg) // the contactless one", "}"]),
      file("README.md", ["-Run `NewUniversalChatbot` for the universal flow.", "+Run `NewContactlessChatbot` for the contactless flow."]),
    ];
    const ren = renameOnlyHunks(files);
    expect(ren.size).toBe(2);
    expect([...ren.values()][0]).toBe("Universal→Contactless");
  });

  it("refuses a swap inside a code string: that is where stored values live", () => {
    expect(ids([file("a.go", ['-\tkind := "detailed_info_universal"', '+\tkind := "detailed_info_contactless"'])])).toEqual([]);
  });

  it("refuses anything else changing on the line, an unpaired line, or a reindent", () => {
    expect(ids([file("a.go", ["-\tfoo(a, 1)", "+\tbar(a, 2)"])])).toEqual([]);
    expect(ids([file("a.go", ["-\tfoo(a)", "+\tbar(a)", "+\tbaz()"])])).toEqual([]);
    expect(ids([file("a.go", ["-\tfoo(a)", "+  foo(a)"])])).toEqual([]);
  });

  it("refuses a swap whose old name is still on the new side, or whose new name was on the old side", () => {
    // foo→bar here, while foo is still called elsewhere: a different function, not a rename.
    expect(ids([file("a.go", ["-\tfoo(a)", "+\tbar(a)"], ["\tfoo(b)"])])).toEqual([]);
    // bar existed before the PR: calling it instead of foo is a change.
    expect(ids([file("a.go", ["-\tfoo(a)", "+\tbar(a)"], ["-\tbar(b)"])])).toEqual([]);
  });

  it("refuses a new thing taking an old one's place: its declaration does not pair", () => {
    expect(
      ids([
        file("a.go", ["-\tarn := one", "+\tarns := []string{one, two}"]),
        file("b.go", ['-\t"Resource": arn,', '+\t"Resource": arns,']),
      ]),
    ).toEqual([]);
    // The same declaration renamed whole: both hunks are renames.
    expect(
      ids([file("a.go", ["-\tarn := one", "+\tresource := one"]), file("b.go", ['-\t"Resource": arn,', '+\t"Resource": resource,'])]),
    ).toHaveLength(2);
  });

  it("refuses a name that becomes two different names across the PR", () => {
    expect(ids([file("a.go", ["-\tfoo(a)", "+\tbar(a)"], ["-\tfoo(b)", "+\tbaz(b)"])])).toEqual([]);
  });

  it("leaves generated files out", () => {
    const gen = { ...file("gen.pb.go", ["-\tfoo(a)", "+\tbar(a)"]), generated: true };
    expect(ids([gen])).toEqual([]);
  });
});
