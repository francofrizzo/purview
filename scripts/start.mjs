#!/usr/bin/env node
// pnpm start — build if stale, restart the server on :4779.
import { execSync, spawn } from "node:child_process";
import { existsSync, statSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PURVIEW_PORT ?? process.env.REVIEWER_PORT ?? 4779);

// newest mtime under a dir, skipping node_modules and dotfiles
function newest(dir) {
  let max = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    max = Math.max(max, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return max;
}

const stale = ["core", "server", "web"].some((pkg) => {
  const src = join(root, "packages", pkg, "src");
  const dist = join(root, "packages", pkg, "dist");
  return !existsSync(dist) || newest(src) > newest(dist);
});

if (stale) {
  console.log("[purview] sources changed — building…");
  execSync("pnpm -r build", { cwd: root, stdio: "inherit" });
}

// stop an existing purview server on the port (only our own dist process)
try {
  const pids = execSync(`lsof -ti:${PORT}`, { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  for (const pid of pids) {
    const cmd = execSync(`ps -o command= -p ${pid}`, { encoding: "utf8" });
    if (cmd.includes("packages/server/dist")) {
      console.log(`[purview] stopping previous server (pid ${pid})`);
      process.kill(Number(pid));
    }
  }
} catch { /* nothing listening */ }

await new Promise((r) => setTimeout(r, 300));
const child = spawn("node", [join(root, "packages/server/dist/index.js")], { cwd: root, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
