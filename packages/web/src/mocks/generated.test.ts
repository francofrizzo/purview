/**
 * Mock mode must build and rebuild the generated unit the way the server is
 * specified to, or the override round trip in the UI tests nothing real.
 */
import { describe, expect, it } from "vitest";
import { GENERATED_UNIT_ID, type FileEntry } from "../api/types";
import { MOCK_KEY } from "./fixture";
import { buildGeneratedUnit } from "./generated";
import { mockApi } from "./server";

const file = (path: string, ids: string[], over: Partial<FileEntry> = {}): FileEntry => ({
  path,
  additions: 600,
  deletions: 150,
  hunks: ids.map((id) => ({ id, file: path, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, header: "@@" })),
  ...over,
});

describe("buildGeneratedUnit", () => {
  it("holds every hunk of every generated file, and says what and why", () => {
    const unit = buildGeneratedUnit([
      file("src/a.ts", ["a"]),
      file("pnpm-lock.yaml", ["l1", "l2"], { generated: { source: "lockfile" } }),
      file("x.pb.go", ["g"], { generated: { source: "path", detail: "*.pb.go" } }),
      file("y.pb.go", ["h"], { generated: { source: "path", detail: "*.pb.go" } }),
    ]);
    expect(unit).toMatchObject({
      id: GENERATED_UNIT_ID,
      origin: "generated",
      attention: "skip",
      title: "Generated & lockfiles",
      hunkIds: ["l1", "l2", "g", "h"],
      summary: "1 lockfile, 2 generated files · +1,800 −450",
    });
    expect(unit!.attentionWhy).toContain("lockfile names, path conventions");
  });

  it("is no unit at all once nothing is generated", () => {
    expect(buildGeneratedUnit([file("src/a.ts", ["a"])])).toBeNull();
  });
});

describe("mock POST /generated", () => {
  const generatedUnit = async () =>
    (await mockApi.getPr(MOCK_KEY)).state.units.find((u) => u.origin === "generated");

  it("un-marks a file into no unit, then marks it back, remembering both in the repo config", async () => {
    const lock = (await mockApi.getPr(MOCK_KEY)).files.files.find((f) => f.path === "pnpm-lock.yaml")!;
    const lockHunk = lock.hunks[0].id;

    const off = await mockApi.setGenerated(MOCK_KEY, "pnpm-lock.yaml", false);
    expect(off.generated).not.toContain("pnpm-lock.yaml");
    expect((await generatedUnit())!.hunkIds).not.toContain(lockHunk);
    const pr = await mockApi.getPr(MOCK_KEY);
    expect(pr.state.units.some((u) => u.hunkIds.includes(lockHunk))).toBe(false);
    expect((await mockApi.getRepoConfig("github.com/acme/billing")).local.generated?.exclude).toContain(
      "pnpm-lock.yaml",
    );

    const on = await mockApi.setGenerated(MOCK_KEY, "pnpm-lock.yaml", true);
    expect(on.generated).toContain("pnpm-lock.yaml");
    expect((await generatedUnit())!.hunkIds).toContain(lockHunk);
    const generated = (await mockApi.getRepoConfig("github.com/acme/billing")).local.generated!;
    expect(generated.include).toContain("pnpm-lock.yaml");
    expect(generated.exclude).not.toContain("pnpm-lock.yaml");
  });

  it("pulls a marked file's hunks out of the unit that held them", async () => {
    const docs = (await mockApi.getPr(MOCK_KEY)).files.files.find((f) => f.path === "docs/billing.md")!;
    await mockApi.setGenerated(MOCK_KEY, "docs/billing.md", true);
    const pr = await mockApi.getPr(MOCK_KEY);
    const holders = pr.state.units.filter((u) => u.hunkIds.includes(docs.hunks[0].id));
    expect(holders.map((u) => u.id)).toEqual([GENERATED_UNIT_ID]);
    await mockApi.setGenerated(MOCK_KEY, "docs/billing.md", false);
  });
});
