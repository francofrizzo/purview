import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { writeConfig } from "../src/config.js";
import { createUpdateChecker, newerThan, newestReleaseTag } from "../src/updates.js";

const LS = `
0c5dbb6c924a82069ec4cb5f80892fcf5276e224\trefs/tags/v2026.10.14.3
9c764a922a5753c2e6a82cc6c472c7262a005a51\trefs/tags/v2026.10.14.3^{}
b1d3150862a849abed2c633e535fe28ced71ebd5\trefs/tags/v2026.10.9.1
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/v2026.10.14.10
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/tags/release-candidate
cccccccccccccccccccccccccccccccccccccccc\trefs/tags/v0.1.0
`;

describe("newestReleaseTag", () => {
  it("picks the numerically newest vYYYY.M.D.N tag and ignores the rest", () => {
    expect(newestReleaseTag(LS)).toBe("2026.10.14.10");
  });
  it("is null without release tags", () => {
    expect(newestReleaseTag("x\trefs/tags/v0.1.0\n")).toBeNull();
    expect(newestReleaseTag("")).toBeNull();
  });
});

describe("newerThan", () => {
  it("reports the remote only when it is ahead", () => {
    expect(newerThan("2026.10.14.3", "2026.10.14.10")).toBe("2026.10.14.10");
    expect(newerThan("2026.10.14.10", "2026.10.14.10")).toBeNull();
    expect(newerThan("2026.10.15.1", "2026.10.14.10")).toBeNull();
    expect(newerThan(null, "2026.10.14.10")).toBe("2026.10.14.10");
    expect(newerThan("2026.10.14.3", null)).toBeNull();
  });
});

describe("createUpdateChecker", () => {
  it("asks once, then answers from memory until the interval passes", async () => {
    let calls = 0;
    let t = 1_000_000;
    const checker = createUpdateChecker({
      lsRemote: async () => (calls++, LS),
      now: () => t,
      intervalMs: 1000,
    });
    expect(await checker.status("2026.10.14.3")).toEqual({
      latest: "2026.10.14.10",
      checkedAt: new Date(1_000_000).toISOString(),
    });
    t += 500;
    await checker.status("2026.10.14.3");
    expect(calls).toBe(1);
    t += 600;
    await checker.status("2026.10.14.3");
    expect(calls).toBe(2);
  });

  it("holds a failure too, instead of retrying every request", async () => {
    let calls = 0;
    const checker = createUpdateChecker({
      lsRemote: async () => {
        calls++;
        throw new Error("offline");
      },
      now: () => 5,
    });
    expect(await checker.status("2026.10.14.3")).toEqual({ latest: null, checkedAt: new Date(5).toISOString() });
    await checker.status("2026.10.14.3");
    expect(calls).toBe(1);
  });

  it("does not wait longer than waitMs for a slow remote, and fills in later", async () => {
    let release!: (s: string) => void;
    const checker = createUpdateChecker({
      lsRemote: () => new Promise<string>((r) => (release = r)),
      waitMs: 10,
    });
    expect(await checker.status("2026.10.14.3")).toEqual({ latest: null, checkedAt: null });
    release(LS);
    await new Promise((r) => setTimeout(r, 0));
    expect((await checker.status("2026.10.14.3")).latest).toBe("2026.10.14.10");
  });
});

describe("GET /api/version update fields", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-updates-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const appWith = (lsRemote: () => Promise<string>) =>
    createApp({
      stateDir: root,
      webDist: path.join(root, "__no-web-dist__"),
      autoAnalyze: false,
      reviewRequestRefresh: false,
      updateChecker: createUpdateChecker({ lsRemote }),
    });

  it("reports a newer release on origin", async () => {
    const app = appWith(async () => "x\trefs/tags/v2999.1.1.1\n");
    const body = await (await app.request("/api/version")).json();
    expect(body.latest).toBe("2999.1.1.1");
    expect(body.updateCheck).toBe(true);
    expect(typeof body.checkedAt).toBe("string");
  });

  it("is quiet when the reader turned the check off, and the flag round-trips through /api/config", async () => {
    let calls = 0;
    const app = appWith(async () => (calls++, "x\trefs/tags/v2999.1.1.1\n"));
    const put = await app.request("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ updateCheck: false }),
    });
    expect((await put.json()).updateCheck).toBe(false);
    const body = await (await app.request("/api/version")).json();
    expect(body).toMatchObject({ latest: null, checkedAt: null, updateCheck: false });
    expect(calls).toBe(0);
  });

  it("POST /api/version/check asks again even inside the interval", async () => {
    let tags = "x\trefs/tags/v2026.10.14.3\n";
    const app = appWith(async () => tags);
    expect((await (await app.request("/api/version")).json()).latest).toBeNull();
    tags = "x\trefs/tags/v2999.1.1.1\n";
    expect((await (await app.request("/api/version")).json()).latest).toBeNull();
    const forced = await (await app.request("/api/version/check", { method: "POST" })).json();
    expect(forced.latest).toBe("2999.1.1.1");
    expect((await (await app.request("/api/version")).json()).latest).toBe("2999.1.1.1");
  });

  it("defaults the flag on for an existing config file without it", async () => {
    writeConfig({ lastSeenVersion: "2026.10.9.1" }, root);
    const app = appWith(async () => "");
    const body = await (await app.request("/api/config")).json();
    expect(body.updateCheck).toBe(true);
  });
});
