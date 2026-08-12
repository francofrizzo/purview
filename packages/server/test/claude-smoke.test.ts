import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runClaude, setClaudeSpawner } from "../src/claude-runner.js";

/**
 * The one test that really spawns `claude`. It exists to catch a CLI whose
 * flags have drifted out from under the runner — every other test fakes the
 * child, so nothing else would notice. Skipped on CI and wherever the CLI is
 * absent or unauthenticated.
 */
function claudeAvailable(): boolean {
  if (process.env.CI) return false;
  if (process.env.REVIEWER_SKIP_CLAUDE_SMOKE) return false;
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!claudeAvailable())("real claude CLI", () => {
  it(
    "answers a trivial prompt over stream-json with no tools",
    async () => {
      setClaudeSpawner(null);
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-smoke-"));
      const run = runClaude({
        label: "smoke",
        prompt: "reply with exactly: pong",
        cwd,
        tools: [],
        timeoutMs: 120_000,
      });

      let text = "";
      let ok = false;
      let error: string | undefined;
      for await (const event of run.events) {
        if (event.type === "text") text += event.text;
        if (event.type === "done") {
          ok = event.ok;
          error = event.error;
        }
      }
      fs.rmSync(cwd, { recursive: true, force: true });

      expect(error).toBeUndefined();
      expect(ok).toBe(true);
      expect(text.toLowerCase()).toContain("pong");
    },
    150_000,
  );
});
