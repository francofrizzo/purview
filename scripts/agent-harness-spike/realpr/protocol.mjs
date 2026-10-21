import fs from "node:fs";
import path from "node:path";
export const arms = {
  "claude-code": { harness: "claude-code", model: "sonnet" },
  "claude-shared": { harness: "claude-shared", model: "sonnet" },
  codex: { harness: "codex", model: "gpt-6.1-sol" },
};
export function checkKey(repo, prs) {
  if (!/^[\w.-]+\/[\w.-]+\/[\w.-]+$/.test(repo ?? "") || repo.split("/").some(x => x === "." || x === "..") || !prs.length || prs.some(n => !/^[1-9]\d*$/.test(n) || !Number.isSafeInteger(Number(n)))) throw Error("invalid repo or PR number");
}
export function checkPort(port) {
  if (!/^\d+$/.test(port ?? "") || Number(port) < 1024 || Number(port) > 65535 || Number(port) === 4779) throw Error("unsafe port");
  return Number(port);
}
export function canonical(p) {
  p = path.resolve(p);
  if (fs.existsSync(p)) return fs.realpathSync(p);
  return path.join(canonical(path.dirname(p)), path.basename(p));
}
export function overlaps(a, b) { return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep); }
export function client(port) {
  const base = `http://127.0.0.1:${checkPort(port)}/api`;
  return async (p, init) => {
    const r = await fetch(base + p, { ...init, signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw Error(`HTTP ${r.status}`);
    return r.json();
  };
}
export function selection(arm) {
  if (!arms[arm]) throw Error("explicit arm required");
  return arms[arm];
}
export function verify(agent, expected, local = false) {
  if (!agent || agent.problem || agent.harness !== expected.harness || agent.model !== expected.model || (local && (agent.sources?.harness !== "repo" || agent.sources?.model !== "repo"))) throw Error("effective agent mismatch");
}
export const post = body => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
export async function preflight(j, repo, expected) {
  const c = await j(`/repos/${encodeURIComponent(repo)}/config`);
  if (c.effective?.autoAnalyze !== false) throw Error("automatic analysis must be disabled");
  verify(c.effective.analysisAgent, expected, true);
  verify(c.effective.chatAgent, expected, true);
}
