import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gh, ghAsync, githubOfflineSince, resetGithubOffline, setGhTimeout } from "../src/github.js";

/**
 * A fake `gh` on PATH: `mode` decides what it does, and every run is counted
 * so a test can tell a call that failed at once from one that ran.
 */
let dir: string;
let savedPath: string | undefined;
const setMode = (mode: "offline" | "hang" | "ok" | "404") => fs.writeFileSync(path.join(dir, "mode"), mode);
const runs = () => (fs.existsSync(path.join(dir, "runs")) ? fs.readFileSync(path.join(dir, "runs"), "utf8").length : 0);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "purview-gh-"));
  fs.writeFileSync(
    path.join(dir, "gh"),
    `#!/bin/sh
printf x >> "${dir}/runs"
case "$(cat "${dir}/mode")" in
  offline) echo 'error connecting to api.github.com' >&2; exit 1 ;;
  hang) exec sleep 5 ;;
  404) echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
  *) echo '{}' ;;
esac
`,
    { mode: 0o755 },
  );
  savedPath = process.env.PATH;
  process.env.PATH = `${dir}:${savedPath}`;
  resetGithubOffline();
});

afterEach(() => {
  process.env.PATH = savedPath;
  setGhTimeout(30_000);
  resetGithubOffline();
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("gh offline", () => {
  it("a call that can't connect marks GitHub offline, and the next ones fail without running gh", async () => {
    setMode("offline");
    await expect(ghAsync(["api", "user"])).rejects.toThrow(/error connecting/);
    expect(githubOfflineSince()).not.toBeNull();
    expect(runs()).toBe(1);

    await expect(ghAsync(["api", "user"])).rejects.toMatchObject({ name: "GithubOfflineError" });
    expect(() => gh(["api", "user"])).toThrow(/can't be reached/);
    expect(runs()).toBe(1);
  });

  it("after the retry window one call tries again, and its answer brings GitHub back", async () => {
    setMode("offline");
    await expect(ghAsync(["api", "user"])).rejects.toThrow();
    setMode("ok");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 21_000);
    await expect(ghAsync(["api", "user"])).resolves.toBe("{}\n");
    expect(githubOfflineSince()).toBeNull();
  });

  it("a call that never answers is cut at the timeout and counts as offline", async () => {
    setMode("hang");
    setGhTimeout(300);
    await expect(ghAsync(["api", "user"])).rejects.toThrow(/timed out/);
    expect(githubOfflineSince()).not.toBeNull();
  });

  it("a call still waiting after the suspect delay marks GitHub offline and cuts every call waiting", async () => {
    setMode("hang");
    setGhTimeout(5_000, 200);
    const started = Date.now();
    const [first, second] = await Promise.allSettled([ghAsync(["api", "user"]), ghAsync(["api", "rate_limit"])]);
    expect(first).toMatchObject({ status: "rejected", reason: { name: "GithubOfflineError" } });
    expect(second).toMatchObject({ status: "rejected", reason: { name: "GithubOfflineError" } });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(githubOfflineSince()).not.toBeNull();
    await expect(ghAsync(["api", "user"])).rejects.toThrow(/can't be reached/);
  });

  it("an HTTP error from GitHub is an answer: GitHub is online", async () => {
    setMode("404");
    expect(() => gh(["api", "repos/x/y"])).toThrow(/HTTP 404/);
    expect(githubOfflineSince()).toBeNull();
  });
});
