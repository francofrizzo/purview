// drive.mjs <port> <host/owner/repo> <pr-number> [fresh|refresh] — one analysis on a running private server
// (refresh = POST refresh, then an incremental analysis); polls the job; prints a sanitized snapshot: counts and titles only.
const [port, repo, n, mode = "fresh"] = process.argv.slice(2);
const key = encodeURIComponent(`${repo}/${n}`); const P = `http://127.0.0.1:${port}/api`;
const j = async (p, init) => { const r = await fetch(P + p, init); if (!r.ok) throw new Error(`${p}: ${r.status} ${await r.text()}`); return r.json(); };
const t0 = Date.now();
if (mode === "refresh") { const r = await j(`/prs/${key}/refresh`, { method: "POST" }); console.log("refresh:", JSON.stringify({ revision: r.revision, noop: r.noop, report: r.report && { newHunks: r.report.newHunks?.length ?? r.report.added?.length, reworked: r.report.reworked?.length ?? r.report.reworkedHunks?.length } }).slice(0, 300)); }
await j(`/prs/${key}/analyze`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fresh: mode === "fresh" }) });
let job;
for (;;) { await new Promise(r => setTimeout(r, 5000)); ({ analysisJob: job } = await j(`/prs/${key}`)); if (!job || !["queued", "running"].includes(job.status)) break; }
const d = await j(`/prs/${key}`); const s = d.state ?? d;
const units = s.units ?? []; const hunksTotal = (d.files ?? []).reduce((a, f) => a + (f.hunks?.length ?? 0), 0);
console.log(JSON.stringify({ pr: n, mode, status: job?.status, error: job?.error, harness: job?.harness, model: job?.model ?? job?.modelResolved, wallS: Math.round((Date.now() - t0) / 1000),
  usage: job?.usage, revision: s.currentRevision, units: units.length, skipped: units.filter(u => u.skip || u.kind === "skip").length,
  findings: units.reduce((a, u) => a + (u.findings?.length ?? 0), 0), warnings: units.reduce((a, u) => a + (u.findings ?? []).filter(f => f.severity === "warning").length, 0),
  unassigned: s.unassignedHunkIds?.length, titles: units.map(u => u.title) }, null, 1));
