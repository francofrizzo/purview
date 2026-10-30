import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installPrompt, skillRevision, stampSkill, stampedRevision } from "./agent-skill.js";
import { log as serverLog } from "./log.js";
import { agentSkillDir } from "./skill-paths.js";

const usage = `Usage: purview skill install [--claude] [--codex] [--agents] [--project] [--dir <path>]
       purview skill prompt

By default, install for each existing ~/.claude, ~/.codex, or ~/.agents directory.
--project uses those directories in the current project; --dir installs into <path>/purview.`;

export function runSkillCommand(args: string[], options: {
  port: number;
  home?: string;
  cwd?: string;
  source?: string;
  print?: (line: string) => void;
}): number {
  const print = options.print ?? ((text: string) => process.stdout.write(text + "\n"));
  if (!args.length || args.includes("--help")) { print(usage); return 0; }
  if (args[0] === "prompt" && args.length === 1) { print(installPrompt(options.port)); return 0; }
  if (args[0] !== "install") { print(`Unknown skill command: ${args.join(" ")}\n${usage}`); return 1; }
  const targets = new Set<string>();
  let project = false;
  let directory: string | undefined;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (["--claude", "--codex", "--agents"].includes(arg)) targets.add(`.${arg.slice(2)}`);
    else if (arg === "--project") project = true;
    else if (arg === "--dir" && args[i + 1] && !args[i + 1].startsWith("--")) directory = args[++i];
    else { print(`Invalid skill install option: ${arg}\n${usage}`); return 1; }
  }
  const cwd = options.cwd ?? process.cwd();
  const base = project ? cwd : options.home ?? os.homedir();
  let destinations: string[];
  if (directory !== undefined) destinations = [path.resolve(cwd, directory, "purview")];
  else {
    if (!targets.size) {
      for (const name of [".claude", ".codex", ".agents"]) {
        if (fs.existsSync(path.join(base, name)) && fs.statSync(path.join(base, name)).isDirectory()) targets.add(name);
      }
      if (!targets.size) {
        targets.add(".agents");
        print("No agent directories found; using .agents/skills/purview.");
      }
    }
    destinations = [...targets].map((name) => path.resolve(base, name, "skills", "purview"));
  }
  const source = fs.realpathSync(options.source ?? agentSkillDir());
  const revision = skillRevision(source);
  for (const destination of destinations) {
    const previous = installSkillCopy(source, destination, revision);
    const status = previous === revision ? `already at ${revision}`
      : previous ? `updated from ${previous} to ${revision}` : `revision ${revision}`;
    print(`Installed Purview skill (${status}): ${destination}`);
  }
  print("Run `purview skill prompt` for a prompt to install in any other agent.");
  return 0;
}

/**
 * Replace `destination` with a fresh copy of the skill at `source`, its
 * SKILL.md stamped with `revision`. Returns the revision the replaced copy
 * carried, or null when there was none (or no copy at all).
 */
export function installSkillCopy(source: string, destination: string, revision: string): string | null {
  // Validate the source before replacing an older installation.
  fs.accessSync(path.join(source, "SKILL.md"));
  if (destination === source || source.startsWith(destination + path.sep) || destination.startsWith(source + path.sep)) {
    throw new Error("The installation destination must be separate from the source skill.");
  }
  let previous: string | null = null;
  try { previous = stampedRevision(fs.readFileSync(path.join(destination, "SKILL.md"), "utf8")); } catch { /* not installed */ }
  // Build the new copy beside the old one and swap them, so a failure part
  // way (a read-only directory, say) leaves the old copy whole.
  const staged = `${destination}.${process.pid}.new`;
  const retired = `${destination}.${process.pid}.old`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.rmSync(staged, { recursive: true, force: true });
  try {
    fs.cpSync(source, staged, { recursive: true });
    const skillMd = path.join(staged, "SKILL.md");
    fs.writeFileSync(skillMd, stampSkill(fs.readFileSync(skillMd, "utf8"), revision));
    const exists = fs.existsSync(destination) || isLink(destination);
    if (exists) fs.renameSync(destination, retired);
    fs.renameSync(staged, destination);
    if (exists) fs.rmSync(retired, { recursive: true, force: true });
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
  }
  return previous;
}

function isLink(file: string): boolean {
  try { return fs.lstatSync(file).isSymbolicLink(); } catch { return false; }
}

type RefreshLog = Pick<typeof serverLog, "info" | "warn">;

/**
 * At server startup: bring the copies `purview skill install` put in
 * ~/.claude, ~/.codex and ~/.agents up to the current revision. Only a copy
 * whose SKILL.md carries a revision stamp is replaced; unstamped copies (hand
 * edited, or installed some other way) and missing ones are left alone, and
 * --project/--dir installs are out of reach. Never throws.
 */
export function refreshInstalledSkills(options: { home?: string; source?: string; log?: RefreshLog } = {}): string[] {
  const logger = options.log ?? serverLog;
  const refreshed: string[] = [];
  try {
    const home = options.home ?? os.homedir();
    const source = fs.realpathSync(options.source ?? agentSkillDir());
    const revision = skillRevision(source);
    for (const name of [".claude", ".codex", ".agents"]) {
      const destination = path.join(home, name, "skills", "purview");
      try {
        let stamped: string | null;
        try {
          stamped = stampedRevision(fs.readFileSync(path.join(destination, "SKILL.md"), "utf8"));
        } catch (err) {
          if (["ENOENT", "ENOTDIR"].includes((err as NodeJS.ErrnoException).code ?? "")) continue;
          throw err;
        }
        if (!stamped || stamped === revision) continue;
        installSkillCopy(source, destination, revision);
        refreshed.push(destination);
        logger.info("skill", `refreshed Purview skill ${stamped} → ${revision}`, { path: destination });
      } catch (err) {
        logger.warn("skill", "could not refresh Purview skill", { path: destination, reason: (err as Error).message });
      }
    }
  } catch (err) {
    logger.warn("skill", "could not check installed Purview skills", { reason: (err as Error).message });
  }
  return refreshed;
}
