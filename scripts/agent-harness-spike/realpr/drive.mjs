// drive.mjs <port> <repo> <pr> <arm> [fresh|refresh]
import { checkKey, client, selection, verify, preflight, post } from "./protocol.mjs";
try {
  const [port, repo, n, arm, mode = "fresh"] = process.argv.slice(2);
  checkKey(repo, [n]);
  if (!["fresh", "refresh"].includes(mode)) throw Error("invalid mode");
  const expected = selection(arm), j = client(port), key = encodeURIComponent(`${repo}/${n}`), p = `/prs/${key}`;
  await preflight(j, repo, expected);
  const before = await j(p);
  if (before.checkoutMismatch || ["queued", "running"].includes(before.analysisJob?.status)) throw Error("analysis active or checkout mismatch");
  if (mode === "refresh") {
    const r = await j(`${p}/refresh`, post({}));
    console.log(JSON.stringify({ stage: "refresh", noop: r.noop === true }));
    await preflight(j, repo, expected);
    if ((await j(p)).checkoutMismatch) throw Error("checkout mismatch after refresh");
  }
  const t = Date.now();
  const started = (await j(`${p}/analyze`, post({ fresh: mode === "fresh" }))).job;
  let d;
  do {
    d = await j(p);
    if (!["queued", "running"].includes(d.analysisJob?.status)) break;
    if (Date.now() - t > 3600000) throw Error("analysis polling timeout; job may still be running");
    await new Promise(r => setTimeout(r, 1000));
  } while (true);
  const job = d.analysisJob, run = job?.metrics?.run;
  verify(run, expected);
  if (!started || job.queuedAt !== started.queuedAt || job.revision !== started.revision || job.revision !== d.state?.currentRevision || d.checkoutMismatch) throw Error("stale or mismatched result");
  const s = d.state, units = s?.units;
  if (job.status !== "done" || !Array.isArray(units) || !Array.isArray(s.unassignedHunkIds)) throw Error("analysis result incomplete");
  console.log(JSON.stringify({ status: job.status, harness: run.harness, model: run.model,
    resolvedModelMatchesRequested: run.resolvedModel == null ? null : run.resolvedModel === run.model,
    usage: Object.fromEntries(["input", "output", "cacheRead", "cacheCreation"].filter(k => Number.isFinite(job.metrics.usage?.[k])).map(k => [k, job.metrics.usage[k]])),
    wallS: Math.round((Date.now() - t) / 1000), units: units.length,
    findings: units.reduce((a, u) => a + (u.findings?.length ?? 0), 0), unassigned: s.unassignedHunkIds.length }));
  if (!units.length || s.unassignedHunkIds.length) throw Error("analysis coverage requires review");
} catch { console.error("comparison failed (details withheld); inspect private state locally"); process.exitCode = 1; }
