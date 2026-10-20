import crypto from "node:crypto";
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

/** A short digest of the skill's files: changes exactly when the skill does. */
export function skillRevision(dir: string): string {
  const hash = crypto.createHash("sha256");
  for (const relative of filesUnder(dir)) {
    hash.update(`${relative}\0`).update(fs.readFileSync(path.join(dir, relative))).update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

/** The frontmatter `revision:` line of an installed SKILL.md, if any. */
export function stampedRevision(skillMd: string): string | null {
  const frontmatter = skillMd.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return frontmatter?.[1].match(/^revision:\s*(\S+)\s*$/m)?.[1] ?? null;
}

/** SKILL.md with `revision: <digest>` written into its frontmatter. */
export function stampSkill(skillMd: string, revision: string): string {
  const frontmatter = skillMd.match(/^---\r?\n([\s\S]*?)(\r?\n---)/);
  if (!frontmatter) return `---\nrevision: ${revision}\n---\n${skillMd}`;
  const lines = frontmatter[1].split(/\r?\n/).filter((line) => !/^revision:/.test(line));
  return skillMd.replace(frontmatter[0], `---\n${[...lines, `revision: ${revision}`].join("\n")}${frontmatter[2]}`);
}

/** A skill file as served and installed: SKILL.md carries the revision stamp. */
export function skillFileContent(dir: string, relative: string): Buffer {
  const content = fs.readFileSync(skillFilePath(dir, relative));
  return relative === "SKILL.md" ? Buffer.from(stampSkill(content.toString("utf8"), skillRevision(dir))) : content;
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
    revision: skillRevision(dir),
    files: filesUnder(dir),
    installPrompt: installPrompt(port),
  }));
  app.get("/*", (c) => {
    const relative = c.req.path.slice("/api/skill/".length);
    const file = skillFilePath(dir, relative);
    return new Response(skillFileContent(dir, path.relative(fs.realpathSync(dir), file)), {
      headers: {
        "Content-Type": path.extname(file).toLowerCase() === ".md" ? "text/markdown; charset=utf-8" : "text/plain",
        "Cache-Control": "no-cache",
      },
    });
  });
  return app;
}
