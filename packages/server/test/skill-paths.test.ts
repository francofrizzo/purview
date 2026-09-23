import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cliCommand, cliWrapperScript } from "../src/skill-paths.js";

/**
 * cliCommand() must be ONE executable path: a run stores it in a shell
 * variable, and zsh does not word-split `$CLI` — the old `<node> <cli.js>`
 * form failed with exit 127 in half the refreshes.
 */

let root: string;
let cliDir: string;
let fakeCli: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-skill-paths-"));
  cliDir = path.join(root, "pkg-dist");
  fs.mkdirSync(cliDir);
  fakeCli = path.join(cliDir, "cli.js");
  // Echoes what it was run with, so the wrapper's plumbing is observable.
  fs.writeFileSync(
    fakeCli,
    "console.log(JSON.stringify({ node: process.execPath, args: process.argv.slice(2), self: process.env.PURVIEW_CLI_SELF }));\n",
  );
  process.env.PURVIEW_CLI_PATH = fakeCli;
  process.env.PURVIEW_STATE_DIR = path.join(root, "state");
});

afterEach(() => {
  delete process.env.PURVIEW_CLI_PATH;
  delete process.env.PURVIEW_STATE_DIR;
  try {
    fs.chmodSync(cliDir, 0o755);
  } catch {
    /* already gone */
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("cliCommand", () => {
  it("is a single executable file that runs the CLI with this node, args intact", () => {
    const cmd = cliCommand();
    expect(cmd).toBe(path.join(cliDir, "reviewer-state"));
    fs.accessSync(cmd, fs.constants.X_OK);
    const out = JSON.parse(execFileSync(cmd, ["show", "a key", "'glob/**'"], { encoding: "utf8" }));
    expect(out).toEqual({ node: process.execPath, args: ["show", "a key", "'glob/**'"], self: cmd });
  });

  it("works when stored in a shell variable (no word splitting needed)", () => {
    const cmd = cliCommand();
    for (const shell of ["/bin/sh", "/bin/zsh"].filter((s) => fs.existsSync(s))) {
      const out = execFileSync(shell, ["-c", `CLI='${cmd}'; $CLI units x`], { encoding: "utf8" });
      expect(JSON.parse(out).args).toEqual(["units", "x"]);
    }
  });

  it("is idempotent and rewrites a stale wrapper", () => {
    const cmd = cliCommand();
    const mtime = fs.statSync(cmd).mtimeMs;
    expect(cliCommand()).toBe(cmd);
    expect(fs.statSync(cmd).mtimeMs).toBe(mtime);
    fs.writeFileSync(cmd, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    cliCommand();
    expect(fs.readFileSync(cmd, "utf8")).toBe(cliWrapperScript(fakeCli, process.execPath, cmd));
  });

  it("falls back to the state root when the CLI's directory is read-only", () => {
    if (process.getuid?.() === 0) return; // root ignores the mode bits
    fs.chmodSync(cliDir, 0o555);
    const cmd = cliCommand();
    expect(cmd).toBe(path.join(root, "state", "bin", "reviewer-state"));
    expect(JSON.parse(execFileSync(cmd, ["list"], { encoding: "utf8" })).args).toEqual(["list"]);
  });
});
