import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createLogger, shortKey } from "../src/log.js";
import { requestLog } from "../src/request-log.js";

function capture(env: NodeJS.ProcessEnv = {}, isTTY = true) {
  let output = "";
  const log = createLogger({ isTTY, write: text => { output += text; } }, env, () => new Date("2026-10-23T12:27:57Z"));
  return { log, output: () => output };
}
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
describe("terminal logger", () => {
  it("pads scopes to ten columns and keeps severity aligned", () => {
    const c = capture();
    c.log.info("chat", "started"); c.log.warn("analysis", "failed"); c.log.error("github", "failed");
    const lines = plain(c.output()).trimEnd().split("\n");
    expect(lines[0].slice(10)).toBe("chat        started");
    expect(lines[1].slice(10)).toBe("analysis    failed");
    expect(lines[2].slice(10)).toBe("github      ✗ failed");
    expect(c.output()).toContain("\x1b[33m"); expect(c.output()).toContain("\x1b[31m");
  });
  it("uses plain ISO timestamps for pipes even with FORCE_COLOR", () => {
    const c = capture({ FORCE_COLOR: "1" }, false); c.log.info("server", "started");
    expect(c.output()).toBe("2026-10-23T12:27:57.000Z  server      started\n");
  });
  it.each([{ NO_COLOR: "" }, { NO_COLOR: "1", FORCE_COLOR: "1" }, { FORCE_COLOR: "0" }])("respects color overrides %j", env => {
    const c = capture(env); c.log.warn("chat", "failed"); expect(c.output()).not.toContain("\x1b");
  });
  it("emits one parseable JSON object even for multiline payloads", () => {
    const c = capture({ PURVIEW_LOG: "json" }); c.log.child("chat").info("started\ncontext", { model: "opus" });
    expect(c.output().trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(c.output())).toMatchObject({ time: "2026-10-23T12:27:57.000Z", level: "info", scope: "chat", message: "started\ncontext", fields: { model: "opus" } });
  });
  it("truncates long values except in debug mode", () => {
    const c = capture(); c.log.info("claude", "spawn", { cwd: "x".repeat(130) });
    expect(c.output()).toContain("x".repeat(119) + "…"); expect(c.output()).not.toContain("x".repeat(120));
    const d = capture({ PURVIEW_DEBUG: "1" }); d.log.info("claude", "spawn", { cwd: "x".repeat(130) }); expect(d.output()).toContain("x".repeat(130));
  });
  it("indents and dims continuation lines", () => {
    const c = capture(); c.log.error("chat", "failed\nstack", { detail: "first\nsecond" });
    expect(c.output()).toContain("\n  \x1b[2mstack\x1b[0m\n  \x1b[2msecond\x1b[0m\n");
  });
  it("gates debug and supports scoped loggers", () => {
    const c = capture(); c.log.debug("chat", "hidden"); expect(c.output()).toBe("");
    for (const env of [{ PURVIEW_DEBUG: "1" }, { DEBUG: "other,purview:*" }]) {
      const d = capture(env); d.log.child("chat").debug("visible"); expect(d.output()).toContain("visible");
    }
  });
  it("shortens PR keys", () => expect(shortKey({ host: "github.com", owner: "primo-devs", repo: "core", number: 9388 })).toBe("primo-devs/core#9388"));
});

describe("request logging without a listening server", () => {
  it("logs mutations and failures, shortens keys, and omits polls and query secrets", async () => {
    const c = capture({ PURVIEW_LOG: "json" }); const app = new Hono(); app.use("*", requestLog(c.log));
    app.get("/poll", ctx => ctx.text("ok"));
    app.post("/api/prs/:key/refresh", ctx => ctx.text("ok"));
    app.get("/failure", ctx => ctx.text("failed", 500));
    await app.request("/poll"); expect(c.output()).toBe("");
    await app.request("/api/prs/github.com%2Fowner%2Frepo%2F42/refresh?token=secret", { method: "POST" });
    await app.request("/failure");
    const lines = c.output().trim().split("\n").map(s => JSON.parse(s));
    expect(lines).toHaveLength(2); expect(lines[0].message).toBe("POST /api/prs/owner/repo#42/refresh");
    expect(lines[0].fields.status).toBe("200"); expect(lines[1].level).toBe("error"); expect(c.output()).not.toContain("secret");
  });
  it("logs polls only in debug and captures handled errors", async () => {
    const c = capture({ PURVIEW_DEBUG: "1", PURVIEW_LOG: "json" });
    const app = new Hono(); app.use("*", requestLog(c.log));
    app.onError((_, ctx) => ctx.text("failed", 500));
    app.get("/poll", ctx => ctx.text("ok"));
    app.get("/throw", () => { throw new Error("failed"); });
    await app.request("/poll"); await app.request("/throw");
    const lines = c.output().trim().split("\n").map(s => JSON.parse(s));
    expect(lines.map(l => l.level)).toEqual(["debug", "error"]);
  });
  it("logs SSE headers before the stream finishes", async () => {
    const c = capture(); const app = new Hono(); app.use("*", requestLog(c.log));
    let finish!: () => void; const pending = new Promise<void>(resolve => { finish = resolve; });
    app.post("/stream", ctx => streamSSE(ctx, async () => { await pending; }));
    const res = await app.request("/stream", { method: "POST" });
    expect(c.output()).toContain("POST /stream · started"); finish(); await res.text();
  });
});
