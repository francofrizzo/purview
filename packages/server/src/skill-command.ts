import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installPrompt, skillRevision, stampSkill, stampedRevision } from "./agent-skill.js";
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
    // Validate the source before replacing an older installation.
    fs.accessSync(path.join(source, "SKILL.md"));
    if (destination === source || source.startsWith(destination + path.sep) || destination.startsWith(source + path.sep)) {
      throw new Error("The installation destination must be separate from the source skill.");
    }
    let previous: string | null = null;
    try { previous = stampedRevision(fs.readFileSync(path.join(destination, "SKILL.md"), "utf8")); } catch { /* not installed */ }
    fs.rmSync(destination, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true });
    const skillMd = path.join(destination, "SKILL.md");
    fs.writeFileSync(skillMd, stampSkill(fs.readFileSync(skillMd, "utf8"), revision));
    const status = previous === revision ? `already at ${revision}`
      : previous ? `updated from ${previous} to ${revision}` : `revision ${revision}`;
    print(`Installed Purview skill (${status}): ${destination}`);
  }
  print("Run `purview skill prompt` for a prompt to install in any other agent.");
  return 0;
}
