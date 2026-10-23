import { execFile, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ReviewerConfig } from "./config.js";

export interface Editor { id: string; name: string; available: boolean; command: string }
const candidates = [
  ["code", "Visual Studio Code"], ["cursor", "Cursor"], ["zed", "Zed"],
  ["windsurf", "Windsurf"], ["idea", "IntelliJ IDEA"], ["webstorm", "WebStorm"],
  ["pycharm", "PyCharm"], ["goland", "GoLand"], ["subl", "Sublime Text"],
];
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
/** Parse launcher arguments without a shell; the checkout path is always one argument. */
export function commandArgs(command: string): string[] {
  const args: string[] = [];
  let word = "", q = "", active = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "\\" && q !== "'") { if (++i >= command.length) throw new Error("Trailing escape in editor command"); word += command[i]; active = true; }
    else if (q) { if (c === q) q = ""; else word += c; }
    else if (c === "'" || c === '"') { q = c; active = true; }
    else if (/\s/.test(c)) { if (active) args.push(word); word = ""; active = false; }
    else { word += c; active = true; }
  }
  if (q) throw new Error("Unclosed quote in editor command");
  if (active) args.push(word);
  if (!args[0]) throw new Error("Empty editor command");
  return args;
}
const which = (name: string): Promise<string | undefined> => new Promise(resolve => {
  execFile("which", [name], { timeout: 5000 }, (err, stdout) => resolve(err ? undefined : stdout.trim() || undefined));
});
export async function probeEditors(deps = {
  which, exists: async (p: string) => { try { await access(p); return true; } catch { return false; } },
  platform: process.platform as string, home: os.homedir(), env: process.env,
}): Promise<Editor[]> {
  const editors = await Promise.all(candidates.map(async ([id, name]) => {
    const launcher = await deps.which(id);
    if (launcher) return { id, name, available: true, command: `${quote(launcher)} {path}` };
    if (deps.platform === "darwin") {
      for (const dir of ["/Applications", path.join(deps.home, "Applications")]) {
        const app = path.join(dir, `${name}.app`);
        if (await deps.exists(app)) return { id, name, available: true, command: `open -a ${quote(app)} {path}` };
      }
    }
    return { id, name, available: false, command: `${id} {path}` };
  }));
  const shell = deps.env.VISUAL || deps.env.EDITOR;
  if (shell) {
    try {
      const args = commandArgs(shell);
      if (!/^(?:vi|vim|nvim|nano)$/.test(path.basename(args[0])) && !(path.basename(args[0]) === "emacs" && args.includes("-nw"))) {
        editors.push({ id: "shell", name: "Your shell's editor", available: true, command: `${shell} {path}` });
      }
    } catch { /* malformed environment value is not a launcher */ }
  }
  return editors;
}
let cached: Promise<Editor[]> | undefined;
export const getEditors = () => cached ??= probeEditors();
export function selectedEditor(selection: ReviewerConfig["editor"], editors: Editor[]): Editor | undefined {
  if (selection?.id === "custom") return selection.command?.includes("{path}")
    ? { id: "custom", name: selection.name || "your editor", available: true, command: selection.command } : undefined;
  if (selection) return editors.find(e => e.id === selection.id && e.available);
  // Nothing chosen: the first editor found, in the list's order of
  // preference, so the button works out of the box on a machine with several.
  return editors.find(e => e.available);
}
export async function launchEditor(editor: Editor, checkout: string): Promise<void> {
  const [command, ...args] = commandArgs(editor.command).map(arg => arg.replaceAll("{path}", () => checkout));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
