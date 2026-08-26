import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateStateDir, migrateStateDirOnStartup } from "../src/state-dir.js";

let tmp: string;
let legacy: string;
let next: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "purview-statedir-"));
  legacy = path.join(tmp, ".reviewer");
  next = path.join(tmp, ".purview");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.PURVIEW_STATE_DIR;
  delete process.env.REVIEWER_STATE_DIR;
});

describe("state dir migration", () => {
  it("moves the legacy dir when only it exists, carrying config.json along", () => {
    fs.mkdirSync(path.join(legacy, "github.com/acme/widgets/7"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "config.json"), '{"autoAnalyze":false}\n');

    const result = migrateStateDir(legacy, next);

    expect(result.moved).toBe(true);
    expect(result.message).toContain(legacy);
    expect(result.warning).toBeUndefined();
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(path.join(next, "github.com/acme/widgets/7"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(next, "config.json"), "utf8"))).toEqual({
      autoAnalyze: false,
    });
  });

  it("warns and moves nothing when both dirs exist", () => {
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "config.json"), '{"autoAnalyze":false}\n');
    fs.mkdirSync(next, { recursive: true });
    fs.writeFileSync(path.join(next, "config.json"), '{"autoAnalyze":true}\n');

    const result = migrateStateDir(legacy, next);

    expect(result.moved).toBe(false);
    expect(result.warning).toContain(legacy);
    expect(fs.existsSync(legacy)).toBe(true);
    // The new dir is authoritative and untouched.
    expect(JSON.parse(fs.readFileSync(path.join(next, "config.json"), "utf8"))).toEqual({
      autoAnalyze: true,
    });
  });

  it("is a no-op when there is no legacy dir", () => {
    fs.mkdirSync(next, { recursive: true });
    const result = migrateStateDir(legacy, next);
    expect(result).toMatchObject({ moved: false });
    expect(result.warning).toBeUndefined();
  });

  it("never migrates into an explicitly configured root", () => {
    process.env.PURVIEW_STATE_DIR = next;
    const logged: string[] = [];
    const result = migrateStateDirOnStartup({
      info: (s) => logged.push(s),
      warn: (s) => logged.push(s),
    });
    expect(result.moved).toBe(false);
    expect(logged).toEqual([]);
  });
});
