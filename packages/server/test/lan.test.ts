import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configPath } from "@reviewer/core";
import { createApp } from "../src/app.js";
import { lanEnabled, lanToken, readConfig, writeConfig } from "../src/config.js";
import { buildFixture } from "./fixtures.js";

const PORT = 4779;
const LAN_HOST = "192.168.1.24";
const TOKEN = "t0ken-abcdefghijklmnopqrstuv";
const NO_ENV = {} as NodeJS.ProcessEnv;

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-lan-test-"));
  buildFixture(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/* ---------------------------------------------------- the switch and the token */

describe("lanEnabled", () => {
  it("is off for a plain run", () => {
    expect(lanEnabled(["node", "index.js"], NO_ENV)).toBe(false);
    expect(lanEnabled(["node", "index.js", "--onboard"], NO_ENV)).toBe(false);
  });

  it("is on for --lan, and for PURVIEW_LAN=1", () => {
    expect(lanEnabled(["node", "index.js", "--lan"], NO_ENV)).toBe(true);
    expect(lanEnabled(["node", "index.js"], { PURVIEW_LAN: "1" } as NodeJS.ProcessEnv)).toBe(true);
  });

  it("stores nothing: neither switch leaves an 'enabled' bit behind", () => {
    // The flag is a property of the run, not of the machine — a later run
    // without it must be loopback-only, with no file able to say otherwise.
    expect(lanEnabled(["node", "index.js", "--lan"], NO_ENV)).toBe(true);
    expect(fs.existsSync(configPath(root))).toBe(false);
    lanToken(root);
    expect(Object.keys(readConfig(root).lan)).toEqual(["token"]);
    expect(fs.readFileSync(configPath(root), "utf8")).not.toContain("enabled");
    expect(lanEnabled(["node", "index.js"], NO_ENV)).toBe(false);
  });
});

describe("lanToken", () => {
  it("generates and persists a token the first time one is needed", () => {
    const token = lanToken(root);
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(readConfig(root).lan.token).toBe(token);
  });

  it("keeps the token it already has — a restart must not lock devices out", () => {
    const first = lanToken(root);
    expect(lanToken(root)).toBe(first);
    expect(lanToken(root)).toBe(first);
  });

  it("tightens the config file to 0600 once it carries a token", () => {
    lanToken(root);
    expect(fs.statSync(configPath(root)).mode & 0o777).toBe(0o600);
  });
});

/* --------------------------------------------------------- the live server */

const lanApp = () =>
  createApp({
    stateDir: root,
    webDist: path.join(root, "__no-web-dist__"),
    port: PORT,
    lan: { token: TOKEN, hosts: [LAN_HOST] },
  });

describe("the token bootstrap", () => {
  it("sets the cookie and redirects the token out of the URL", async () => {
    const res = await lanApp().request(`http://${LAN_HOST}:${PORT}/?token=${TOKEN}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`purview_token=${TOKEN}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    // Plain HTTP on a LAN: a Secure cookie would simply never be stored.
    expect(cookie).not.toContain("Secure");
  });

  it("401s a wrong ?token= like any other unauthenticated request", async () => {
    const res = await lanApp().request(`http://${LAN_HOST}:${PORT}/?token=nope`);
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("answers a navigation with a page and an API call with JSON", async () => {
    const app = lanApp();
    const page = await app.request(`http://${LAN_HOST}:${PORT}/`);
    expect(page.status).toBe(401);
    expect(await page.text()).not.toContain(TOKEN);
    const api = await app.request(`http://${LAN_HOST}:${PORT}/api/prs`);
    expect(api.status).toBe(401);
    expect((await api.json()).error).toBe("unauthorized");
  });

  it("serves the app to a LAN device that kept the cookie", async () => {
    const res = await lanApp().request(`http://${LAN_HOST}:${PORT}/api/prs`, {
      headers: { Cookie: `purview_token=${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });
});

describe("/api/lan", () => {
  beforeEach(() => {
    writeConfig({ lan: { token: TOKEN } }, root);
  });

  it("serves the QR and the URL to loopback", async () => {
    const res = await lanApp().request(`http://localhost:${PORT}/api/lan`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.active).toBe(true);
    expect(body.url).toContain(TOKEN);
    expect(body.qrSvg).toContain("<svg");
  });

  it("403s a LAN device, even one holding the token", async () => {
    const res = await lanApp().request(`http://${LAN_HOST}:${PORT}/api/lan`, {
      headers: { Cookie: `purview_token=${TOKEN}` },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("loopback_only");
    expect(JSON.stringify(await readConfig(root))).toContain(TOKEN);
  });

  it("regenerates the token for loopback, and locks the old one out at once", async () => {
    const app = lanApp();
    const res = await app.request(`http://localhost:${PORT}/api/lan/token`, { method: "POST" });
    expect(res.status).toBe(200);
    const next = readConfig(root).lan.token;
    expect(next).not.toBe(TOKEN);
    expect((await res.json()).url).toContain(next);
    const stale = await app.request(`http://${LAN_HOST}:${PORT}/api/prs`, {
      headers: { Cookie: `purview_token=${TOKEN}` },
    });
    expect(stale.status).toBe(401);
  });

  it("403s a regenerate from a LAN device", async () => {
    const res = await lanApp().request(`http://${LAN_HOST}:${PORT}/api/lan/token`, {
      method: "POST",
      headers: { Cookie: `purview_token=${TOKEN}` },
    });
    expect(res.status).toBe(403);
    expect(readConfig(root).lan.token).toBe(TOKEN);
  });
});

describe("a run without --lan", () => {
  it("keeps every LAN name a forbidden host, and reports itself inactive", async () => {
    // Even with a token sitting in config.json from an earlier `--lan` run.
    writeConfig({ lan: { token: TOKEN } }, root);
    const app = createApp({
      stateDir: root,
      webDist: path.join(root, "__no-web-dist__"),
      port: PORT,
    });
    const res = await app.request(`http://${LAN_HOST}:${PORT}/api/prs`);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("forbidden_host");
    const lan = await app.request(`http://localhost:${PORT}/api/lan`);
    expect(await lan.json()).toMatchObject({ active: false, url: null, qrSvg: null });
  });
});
