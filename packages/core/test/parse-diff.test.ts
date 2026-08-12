import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDiff } from "../src/parse-diff.js";
import { computeHunkId, baseHunkId } from "../src/hunk-id.js";

const rev1 = readFileSync(
  fileURLToPath(new URL("./fixtures/rev1.patch", import.meta.url)),
  "utf8",
);

describe("parseDiff", () => {
  const files = parseDiff(rev1);
  const byPath = new Map(files.map((f) => [f.path, f]));

  it("finds every file in the patch", () => {
    expect([...byPath.keys()].sort()).toEqual(
      [
        "assets/logo.png",
        "docs/readme.md",
        "scripts/run.sh",
        "src/auth.ts",
        "src/dup.ts",
        "src/legacy.ts",
        "src/new-feature.ts",
        "src/renamed.ts",
      ].sort(),
    );
  });

  it("classifies file status", () => {
    expect(byPath.get("src/auth.ts")!.status).toBe("modified");
    expect(byPath.get("src/legacy.ts")!.status).toBe("removed");
    expect(byPath.get("src/new-feature.ts")!.status).toBe("added");
    expect(byPath.get("src/renamed.ts")!.status).toBe("renamed");
    expect(byPath.get("src/renamed.ts")!.oldPath).toBe("src/old-name.ts");
    expect(byPath.get("src/renamed.ts")!.similarity).toBe(100);
  });

  it("skips binary content but keeps the file entry", () => {
    const png = byPath.get("assets/logo.png")!;
    expect(png.binary).toBe(true);
    expect(png.hunks).toHaveLength(0);
  });

  it("records mode changes", () => {
    const sh = byPath.get("scripts/run.sh")!;
    expect(sh.oldMode).toBe("100644");
    expect(sh.newMode).toBe("100755");
    expect(sh.hunks).toHaveLength(0);
  });

  it("parses hunk ranges and headers", () => {
    const [h1, h2] = byPath.get("src/auth.ts")!.hunks;
    expect(h1.oldStart).toBe(10);
    expect(h1.oldLines).toBe(6);
    expect(h1.newStart).toBe(10);
    expect(h1.newLines).toBe(7);
    expect(h1.header).toBe("export function login(user: string) {");
    expect(h1.addedLines).toEqual(['    log("failed");']);
    expect(h1.removedLines).toEqual([]);
    expect(h2.removedLines).toEqual([
      '  audit(user, "logout");',
      "  cleanup(user);",
    ]);
  });

  it("splits added/removed lines of a deleted file", () => {
    const legacy = byPath.get("src/legacy.ts")!;
    expect(legacy.hunks).toHaveLength(1);
    expect(legacy.hunks[0].addedLines).toEqual([]);
    expect(legacy.hunks[0].removedLines).toEqual([
      "export function legacy() {",
      "  return 42;",
      "}",
    ]);
  });

  it("disambiguates identical hunks in the same file with #2", () => {
    const dup = byPath.get("src/dup.ts")!;
    expect(dup.hunks).toHaveLength(2);
    expect(baseHunkId(dup.hunks[1].id)).toBe(dup.hunks[0].id);
    expect(dup.hunks[1].id).toBe(`${dup.hunks[0].id}#2`);
  });
});

describe("hunk identity", () => {
  it("is the documented sha256 prefix", () => {
    const files = parseDiff(rev1);
    const h = files.find((f) => f.path === "src/auth.ts")!.hunks[0];
    expect(h.id).toBe(
      computeHunkId("src/auth.ts", ['    log("failed");'], []),
    );
    expect(h.id).toHaveLength(16);
    expect(h.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable: a known input keeps a known id", () => {
    expect(computeHunkId("src/a.ts", ["+one"], [])).toBe(
      computeHunkId("src/a.ts", ["+one"], []),
    );
    // frozen value — changing the hashing scheme must break this test
    expect(computeHunkId("src/a.ts", ["const x = 1;"], ["const x = 0;"])).toBe(
      "5f840f974d4433b1",
    );
  });

  it("ignores position and context, but not path or content", () => {
    const base = computeHunkId("src/a.ts", ["a"], ["b"]);
    expect(computeHunkId("src/b.ts", ["a"], ["b"])).not.toBe(base);
    expect(computeHunkId("src/a.ts", ["a"], ["c"])).not.toBe(base);
    // added/removed are not interchangeable
    expect(computeHunkId("src/a.ts", ["b"], ["a"])).not.toBe(base);
  });

  it("is unchanged when only line numbers move", () => {
    const shifted = rev1.replace("@@ -10,6 +10,7 @@", "@@ -90,6 +91,7 @@");
    const a = parseDiff(rev1).find((f) => f.path === "src/auth.ts")!.hunks[0];
    const b = parseDiff(shifted).find((f) => f.path === "src/auth.ts")!.hunks[0];
    expect(b.id).toBe(a.id);
    expect(b.newStart).toBe(91);
  });
});
