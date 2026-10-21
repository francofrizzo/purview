// prepare.mjs <out-dir> <host/owner/repo> <pr-number>... — one private state root per arm,
// copied out of ~/.purview (or PURVIEW_STATE_DIR). Read-only on the source. No checkouts are
// copied: managedCheckouts is off in the copies, so a run resolves an existing worktree by head
// sha (the live Purview's managed checkout, or the reader's own). These are not isolated. The LAN
// token is dropped; chat, job and scratch records start clean.
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { canonical, overlaps, checkKey } from "./protocol.mjs";
try {
const [OUT, REPO, ...PRS] = process.argv.slice(2);
if (!OUT || !REPO || PRS.length === 0) { console.error("usage: prepare.mjs <out-dir> <host/owner/repo> <pr>..."); process.exit(2); }
const SRC = process.env.PURVIEW_STATE_DIR || path.join(os.homedir(), ".purview");
checkKey(REPO, PRS);
const source = canonical(SRC), destination = canonical(OUT);
if (fs.existsSync(OUT) || overlaps(source, destination) || overlaps(destination, canonical(path.join(os.homedir(), ".purview"))) || destination === path.parse(destination).root) throw Error("unsafe destination");
// Reject symlinks before copying: cleanup must never traverse back into source state.
function checkTree(p) {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) throw Error("symlink in source selection");
  if (st.isDirectory()) for (const f of fs.readdirSync(p)) checkTree(path.join(p, f));
}
for (const n of PRS) checkTree(path.join(SRC, REPO, n));
const ARMS = {
  "claude-code":   { analysisAgent: { harness: "claude-code",   model: "sonnet",      effort: "medium" }, chatAgent: { harness: "claude-code",   model: "sonnet" } },
  "claude-shared": { analysisAgent: { harness: "claude-shared", model: "sonnet",      effort: "medium" }, chatAgent: { harness: "claude-shared", model: "sonnet" } },
  "codex":         { analysisAgent: { harness: "codex",         model: "gpt-6.1-sol", effort: "medium" }, chatAgent: { harness: "codex",         model: "gpt-6.1-sol" } },
};
const base = JSON.parse(fs.readFileSync(path.join(SRC, "config.json"), "utf8"));
fs.mkdirSync(OUT, { mode: 0o700 });
for (const [arm, agents] of Object.entries(ARMS)) {
  const root = path.join(OUT, arm);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const { lan: _lan, ...rest } = base;
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ ...rest, ...agents, autoAnalyze: false, managedCheckouts: false, updateCheck: false, devOrigins: [] }, null, 2));
  if (fs.existsSync(path.join(SRC, "github-user.json"))) fs.copyFileSync(path.join(SRC, "github-user.json"), path.join(root, "github-user.json"));
  fs.mkdirSync(path.join(root, REPO), { recursive: true });
  for (const f of ["repo.json", "RUBRIC.local.md", "CHAT.local.md"]) if (fs.existsSync(path.join(SRC, REPO, f))) fs.copyFileSync(path.join(SRC, REPO, f), path.join(root, REPO, f));
  const localFile = path.join(root, REPO, "repo.json");
  const local = fs.existsSync(localFile) ? JSON.parse(fs.readFileSync(localFile, "utf8")) : {};
  fs.writeFileSync(localFile, JSON.stringify({ ...local, ...agents, autoAnalyze: false }, null, 2));
  for (const n of PRS) {
    fs.cpSync(path.join(SRC, REPO, n), path.join(root, REPO, n), { recursive: true });
    for (const f of ["chat.json", "analysis-job.json", "scratch"]) fs.rmSync(path.join(root, REPO, n, f), { recursive: true, force: true });
  }
  console.log(JSON.stringify({ arm, prepared: true, prs: PRS.length }));
}
} catch { console.error("prepare failed (details withheld); use a new safe destination"); process.exitCode = 1; }
