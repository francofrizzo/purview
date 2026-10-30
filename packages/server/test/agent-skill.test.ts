import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentSkillRoutes, installPrompt, skillFilePath, skillRevision, stampSkill, stampedRevision } from "../src/agent-skill.js";
import { readChangelog } from "../src/changelog.js";
import { classifyError } from "../src/http-error.js";
import { createApp } from "../src/app.js";
import { refreshInstalledSkills, runSkillCommand } from "../src/skill-command.js";

let temp: string;
let source: string;
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "purview-skill-test-"));
  source = path.join(temp, "source");
  fs.mkdirSync(path.join(source, "references"), { recursive: true });
  fs.writeFileSync(path.join(source, "SKILL.md"), "---\nname: purview\ndescription: d\n---\n# Purview\n");
  fs.writeFileSync(path.join(source, "references", "api.md"), "# API\n");
  fs.writeFileSync(path.join(source, "notes.txt"), "notes");
});
afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

function app() {
  const app = new Hono();
  app.onError((err, c) => { const e = classifyError(err); return c.json({ error: e.message }, e.status as 400); });
  app.route("/api/skill", agentSkillRoutes(4880, source));
  return app;
}

describe("agent skill API", () => {
  it("lists every regular file in sorted order and the running version and prompt", async () => {
    fs.symlinkSync(path.join(temp, "outside"), path.join(source, "link"));
    const res = await app().request("/api/skill/manifest.json");
    expect(await res.json()).toEqual({ name: "purview", version: readChangelog()[0]?.version ?? null,
      revision: skillRevision(source), files: ["SKILL.md", "notes.txt", "references/api.md"], installPrompt: installPrompt(4880) });
  });
  it("derives the revision from the files, so it moves only when the skill does", () => {
    const before = skillRevision(source);
    expect(before).toMatch(/^[0-9a-f]{12}$/);
    expect(skillRevision(source)).toBe(before);
    fs.writeFileSync(path.join(source, "references", "api.md"), "# API v2\n");
    expect(skillRevision(source)).not.toBe(before);
  });
  it("serves SKILL.md with the revision stamped into its frontmatter", async () => {
    const text = await (await app().request("/api/skill/SKILL.md")).text();
    expect(text).toBe(`---\nname: purview\ndescription: d\nrevision: ${skillRevision(source)}\n---\n# Purview\n`);
    expect(stampedRevision(text)).toBe(skillRevision(source));
  });
  it("stamps idempotently and copes with a file that has no frontmatter", () => {
    expect(stampSkill(stampSkill("---\nname: x\n---\nbody", "aaa"), "bbb")).toBe("---\nname: x\nrevision: bbb\n---\nbody");
    expect(stampSkill("# bare\n", "ccc")).toBe("---\nrevision: ccc\n---\n# bare\n");
    expect(stampedRevision("# bare\n")).toBeNull();
  });
  it("serves nested Markdown verbatim with no caching", async () => {
    const res = await app().request("/api/skill/references/api.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toBe("# API\n");
  });
  it("serves other files as plain text", async () => {
    const res = await app().request("/api/skill/notes.txt");
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(await res.text()).toBe("notes");
  });
  it.each(["..%2Fsecret", "%252e%252e%252fsecret", "%2Fetc/passwd", "C:%5Csecret", "%ZZ"])("refuses traversal or invalid path %s", async (file) => {
    expect((await app().request(`/api/skill/${file}`)).status).toBe(400);
  });
  it("rejects literal traversal before URL normalization and symlinks escaping the root", async () => {
    expect(() => skillFilePath(source, "../secret")).toThrow("invalid_skill_path");
    fs.writeFileSync(path.join(temp, "secret"), "secret");
    fs.symlinkSync(path.join(temp, "secret"), path.join(source, "link"));
    expect((await app().request("/api/skill/link")).status).toBe(400);
  });
  it("returns 404 for missing files and directories", async () => {
    for (const file of ["missing.md", "references"]) expect((await app().request(`/api/skill/${file}`)).status).toBe(404);
  });
  it("wires the real routes beneath the host guard", async () => {
    const server = createApp({ stateDir: path.join(temp, "state"), port: 4880 });
    expect((await server.request("http://localhost:4880/api/skill/manifest.json")).status).toBe(200);
    expect((await server.request("http://evil.example/api/skill/manifest.json")).status).toBe(403);
  });
  it("uses the requested port in both prompt URLs", () => {
    expect(installPrompt(4880).match(/localhost:4880/g)).toHaveLength(2);
    expect(installPrompt(4880)).toContain("read its `files` list");
  });
});

describe("skill command", () => {
  function run(args: string[]) {
    const lines: string[] = [];
    const status = runSkillCommand(args, { port: 4880, home: path.join(temp, "home"), cwd: temp, source, print: (line) => lines.push(line) });
    return { status, lines };
  }
  function installed(base: string) {
    expect(fs.readFileSync(path.join(base, "purview/references/api.md"), "utf8")).toBe("# API\n");
  }
  it("auto-detects all existing home agent directories", () => {
    for (const agent of [".claude", ".codex"]) fs.mkdirSync(path.join(temp, "home", agent), { recursive: true });
    const { status, lines } = run(["install"]);
    expect(status).toBe(0);
    for (const agent of [".claude", ".codex"]) installed(path.join(temp, "home", agent, "skills"));
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("purview skill prompt");
  });
  it("falls back to agents and explains it", () => {
    expect(run(["install"]).lines[0]).toContain("No agent directories found");
    installed(path.join(temp, "home/.agents/skills"));
  });
  it("installs explicit combined project targets", () => {
    expect(run(["install", "--claude", "--codex", "--agents", "--project"]).status).toBe(0);
    for (const agent of [".claude", ".codex", ".agents"]) installed(path.join(temp, agent, "skills"));
  });
  it("auto-detects project targets", () => {
    fs.mkdirSync(path.join(temp, ".codex"));
    run(["install", "--project"]);
    installed(path.join(temp, ".codex/skills"));
    expect(fs.existsSync(path.join(temp, ".agents"))).toBe(false);
  });
  it("stamps the installed SKILL.md and reports new, unchanged and updated installs", () => {
    const base = path.join(temp, "custom");
    const first = skillRevision(source);
    expect(run(["install", "--dir", base]).lines[0]).toContain(`(revision ${first})`);
    expect(stampedRevision(fs.readFileSync(path.join(base, "purview/SKILL.md"), "utf8"))).toBe(first);
    expect(run(["install", "--dir", base]).lines[0]).toContain(`(already at ${first})`);
    fs.writeFileSync(path.join(source, "notes.txt"), "more notes");
    const second = skillRevision(source);
    expect(run(["install", "--dir", base]).lines[0]).toContain(`(updated from ${first} to ${second})`);
    expect(stampedRevision(fs.readFileSync(path.join(base, "purview/SKILL.md"), "utf8"))).toBe(second);
  });
  it("uses --dir exactly and replaces stale files", () => {
    const base = path.join(temp, "custom");
    run(["install", "--dir", base]);
    fs.writeFileSync(path.join(base, "purview/old.md"), "old");
    const { lines } = run(["install", "--dir", "custom", "--claude", "--project"]);
    installed(base);
    expect(fs.existsSync(path.join(base, "purview/old.md"))).toBe(false);
    expect(lines[0]).toContain(path.join(base, "purview"));
  });
  it("prints the shared prompt", () => expect(run(["prompt"]).lines).toEqual([installPrompt(4880)]));
  it.each([[], ["--help"], ["install", "--help"]])("prints usage for %j", (...args) => {
    const result = run(args as string[]);
    expect(result.status).toBe(0);
    expect(result.lines[0]).toContain("Usage:");
  });
  it.each([["unknown"], ["install", "--dir"], ["install", "--wat"], ["prompt", "extra"]])("rejects invalid arguments %j", (...args) => {
    expect(run(args as string[]).status).toBe(1);
  });
});

describe("skill refresh at startup", () => {
  let home: string;
  beforeEach(() => { home = path.join(temp, "home"); });
  function refresh() {
    const lines: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
    const log = {
      info: (_scope: string, message: string, fields?: Record<string, unknown>) => { lines.push({ level: "info", message, fields }); },
      warn: (_scope: string, message: string, fields?: Record<string, unknown>) => { lines.push({ level: "warn", message, fields }); },
    };
    const refreshed = refreshInstalledSkills({ home, source, log });
    return { refreshed, lines };
  }
  function install(agent: string) {
    runSkillCommand(["install", `--${agent.slice(1)}`], { port: 4880, home, cwd: temp, source, print: () => {} });
    return path.join(home, agent, "skills", "purview");
  }
  const stamp = (dir: string) => stampedRevision(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"));

  it("replaces a stale stamped copy and restamps it", () => {
    const dir = install(".claude");
    const old = skillRevision(source);
    fs.writeFileSync(path.join(dir, "leftover.md"), "old");
    fs.writeFileSync(path.join(source, "notes.txt"), "new notes");
    const { refreshed, lines } = refresh();
    expect(refreshed).toEqual([dir]);
    expect(stamp(dir)).toBe(skillRevision(source));
    expect(fs.readFileSync(path.join(dir, "notes.txt"), "utf8")).toBe("new notes");
    expect(fs.existsSync(path.join(dir, "leftover.md"))).toBe(false);
    expect(lines).toEqual([{ level: "info", message: `refreshed Purview skill ${old} → ${skillRevision(source)}`, fields: { path: dir } }]);
  });
  it("leaves an up-to-date copy alone", () => {
    const dir = install(".codex");
    const skillMd = path.join(dir, "SKILL.md");
    const past = new Date(2020, 0, 1);
    fs.utimesSync(skillMd, past, past);
    const { refreshed, lines } = refresh();
    expect(refreshed).toEqual([]);
    expect(lines).toEqual([]);
    expect(fs.statSync(skillMd).mtimeMs).toBe(past.getTime());
  });
  it("leaves an unstamped copy alone", () => {
    const dir = path.join(home, ".agents/skills/purview");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: purview\n---\n# Mine\n");
    expect(refresh()).toEqual({ refreshed: [], lines: [] });
    expect(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")).toBe("---\nname: purview\n---\n# Mine\n");
    expect(fs.readdirSync(dir)).toEqual(["SKILL.md"]);
  });
  it("never creates a copy that is not there", () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    expect(refresh()).toEqual({ refreshed: [], lines: [] });
    expect(fs.readdirSync(home)).toEqual([".claude"]);
    expect(fs.readdirSync(path.join(home, ".claude"))).toEqual([]);
  });
  it.skipIf(process.getuid?.() === 0)("warns instead of throwing when a copy cannot be read or replaced", () => {
    const unreadable = install(".claude");
    const readOnly = install(".codex");
    fs.writeFileSync(path.join(source, "notes.txt"), "new notes");
    fs.chmodSync(path.dirname(unreadable), 0o000);
    fs.chmodSync(path.dirname(readOnly), 0o555);
    try {
      const { refreshed, lines } = refresh();
      expect(refreshed).toEqual([]);
      expect(lines.map((line) => [line.level, line.fields?.path])).toEqual([["warn", unreadable], ["warn", readOnly]]);
    } finally {
      fs.chmodSync(path.dirname(unreadable), 0o755);
      fs.chmodSync(path.dirname(readOnly), 0o755);
    }
    // The failed replace left the old copy whole, with nothing staged beside it.
    expect(fs.readFileSync(path.join(readOnly, "notes.txt"), "utf8")).toBe("notes");
    expect(fs.readdirSync(path.dirname(readOnly))).toEqual(["purview"]);
  });
  it("warns instead of throwing when the source skill is missing", () => {
    install(".claude");
    fs.rmSync(source, { recursive: true, force: true });
    const { refreshed, lines } = refresh();
    expect(refreshed).toEqual([]);
    expect(lines.map((line) => line.level)).toEqual(["warn"]);
  });
});
