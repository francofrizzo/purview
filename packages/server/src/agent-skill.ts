import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { readChangelog } from "./changelog.js";
import { HttpError } from "./http-error.js";
import { agentSkillDir } from "./skill-paths.js";

export function installPrompt(port: number): string {
  return `Install the Purview skill for this coding agent. 1) Fetch http://localhost:${port}/api/skill/manifest.json and read its \`files\` list. 2) Download every listed file from http://localhost:${port}/api/skill/<path> into a new folder named \`purview\` inside the directory you load skills from: Claude Code uses ~/.claude/skills, Codex uses ~/.codex/skills, other agents use ~/.agents/skills (if I ask for a project-level install, use this project's .claude/skills, .codex/skills or .agents/skills instead). Keep the paths exactly as the manifest lists them, overwriting an older copy. 3) Read the installed SKILL.md, then confirm the install by listing my tracked PRs through it.`;
}

function filesUnder(dir: string, prefix = ""): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) return filesUnder(path.join(dir, entry.name), `${relative}/`);
    return entry.isFile() ? [relative] : [];
  }).sort();
}

export function skillFilePath(dir: string, raw: string): string {
  let relative: string;
  try {
    relative = decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, "invalid_skill_path");
  }
  // Reject nested encoding as well as both platform separators and absolute paths.
  if (relative.includes("%") || relative.includes("\\") || relative.includes("\0") ||
      path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.split("/").includes("..")) {
    throw new HttpError(400, "invalid_skill_path");
  }
  const root = fs.realpathSync(dir);
  const file = path.resolve(root, relative);
  try {
    const real = fs.realpathSync(file);
    if (!real.startsWith(root + path.sep)) throw new HttpError(400, "invalid_skill_path");
    if (!fs.statSync(real).isFile()) throw new HttpError(404, "not_found");
    return real;
  } catch (err) {
    if (["ENOENT", "ENOTDIR"].includes((err as NodeJS.ErrnoException).code ?? "")) {
      throw new HttpError(404, "not_found");
    }
    throw err;
  }
}

export function agentSkillRoutes(port: number, dir = agentSkillDir()): Hono {
  const app = new Hono();
  app.get("/manifest.json", (c) => c.json({
    name: "purview",
    version: readChangelog()[0]?.version ?? null,
    files: filesUnder(dir),
    installPrompt: installPrompt(port),
  }));
  app.get("/*", (c) => {
    const file = skillFilePath(dir, c.req.path.slice("/api/skill/".length));
    return new Response(fs.readFileSync(file), {
      headers: {
        "Content-Type": path.extname(file).toLowerCase() === ".md" ? "text/markdown; charset=utf-8" : "text/plain",
        "Cache-Control": "no-cache",
      },
    });
  });
  return app;
}
