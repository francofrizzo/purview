// prepare.mjs <out-dir> <host/owner/repo> <pr-number>... — one private state root per arm,
// copied out of ~/.purview (or PURVIEW_STATE_DIR). Read-only on the source. No checkouts are
// copied: managedCheckouts is off in the copies, so a run resolves an existing worktree by head
// sha (the live Purview's managed checkout, or the reader's own) and only reads it. The LAN
// token is dropped; chat, job and scratch records start clean.
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const [OUT, REPO, ...PRS] = process.argv.slice(2);
if (!OUT || !REPO || PRS.length === 0) { console.error("usage: prepare.mjs <out-dir> <host/owner/repo> <pr>..."); process.exit(2); }
const SRC = process.env.PURVIEW_STATE_DIR || path.join(os.homedir(), ".purview");
const ARMS = {
  "claude-code":   { analysisAgent: { harness: "claude-code",   model: "sonnet",      effort: "medium" }, chatAgent: { harness: "claude-code",   model: "sonnet" } },
  "claude-shared": { analysisAgent: { harness: "claude-shared", model: "sonnet",      effort: "medium" }, chatAgent: { harness: "claude-shared", model: "sonnet" } },
  "codex":         { analysisAgent: { harness: "codex",         model: "gpt-6.1-sol", effort: "medium" }, chatAgent: { harness: "codex",         model: "gpt-6.1-sol" } },
};
const base = JSON.parse(fs.readFileSync(path.join(SRC, "config.json"), "utf8"));
for (const [arm, agents] of Object.entries(ARMS)) {
  const root = path.join(OUT, arm);
  fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const { lan: _lan, ...rest } = base;
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ ...rest, ...agents, autoAnalyze: false, managedCheckouts: false, updateCheck: false, devOrigins: [] }, null, 2));
  if (fs.existsSync(path.join(SRC, "github-user.json"))) fs.copyFileSync(path.join(SRC, "github-user.json"), path.join(root, "github-user.json"));
  fs.mkdirSync(path.join(root, REPO), { recursive: true });
  for (const f of ["repo.json", "RUBRIC.local.md", "CHAT.local.md"]) if (fs.existsSync(path.join(SRC, REPO, f))) fs.copyFileSync(path.join(SRC, REPO, f), path.join(root, REPO, f));
  for (const n of PRS) {
    fs.cpSync(path.join(SRC, REPO, n), path.join(root, REPO, n), { recursive: true });
    for (const f of ["chat.json", "analysis-job.json", "scratch"]) fs.rmSync(path.join(root, REPO, n, f), { recursive: true, force: true });
  }
  console.log(arm, root);
}
