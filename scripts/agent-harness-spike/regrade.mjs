// Offline, secondary grading of saved synthetic documentation cases. No harness imports.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { setAnalysis } from "../../packages/core/dist/index.js";
import { createEvalFixture } from "./eval-fixture.mjs";

export async function regrade(input, output) {
  const source = fs.readFileSync(input);
  const rows = source.toString("utf8").trim().split("\n").map(JSON.parse);
  const runs = rows.filter(row => row.type === "run");
  if (!runs.length || runs.some(row => !["documented-api-contradiction", "large-documented-api-contradiction"].includes(row.caseId))) {
    throw new Error("Only saved synthetic documentation cases are supported");
  }
  const results = [];
  for (const row of runs) {
    const f = await createEvalFixture(row.caseId, { graderVersion: 2 });
    try {
      const promptHash = createHash("sha256").update(f.prompt).digest("hex");
      if (row.promptHash !== promptHash || !row.observed?.units ||
        !["revision", "noComments", "analysisStored", "coverage", "finding"].every(key => typeof row.grading?.checks?.[key] === "boolean")) {
        throw new Error("Saved case lacks compatible prompt, observations or checks");
      }
      setAnalysis(f.key, { summary: row.observed.summary, units: row.observed.units, unassigned: [] }, {}, f.root);
      // Re-evaluate only the finding clause. Never reconstruct successful transport,
      // revision, comments or coverage from an incomplete snapshot of a past run.
      const checks = { ...row.grading.checks, finding: f.grade().checks.finding };
      results.push({ type: "regrade", caseId: row.caseId, arm: row.arm, repeat: row.repeat,
        originalPass: row.pass, originalGraderVersion: row.grading.graderVersion ?? 1,
        graderVersion: 2, checks, pass: row.ok === true && Object.values(checks).every(value => value === true) });
    } finally { f.dispose(); }
  }
  const report = [
    { type: "regrade-manifest", sourceSha256: createHash("sha256").update(source).digest("hex"),
      graderSourceSha256: createHash("sha256").update(fs.readFileSync(new URL("./eval-fixture.mjs", import.meta.url))).digest("hex"),
      sourceRevision: rows.find(row => row.type === "manifest")?.revision,
      graderVersion: 2, newModelRuns: 0,
      limitations: ["Secondary bounded-English finding check, not new model evidence or general entailment.", "Original reports and all non-finding checks are unchanged."] },
    ...results,
    { type: "summary", completed: results.length, originalPassed: results.filter(r => r.originalPass).length,
      passed: results.filter(r => r.pass).length },
  ];
  // Never overwrite a report, including the source (also through symlinks).
  fs.writeFileSync(output, report.map(row => JSON.stringify(row)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
  return report.at(-1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [input, output, ...extra] = process.argv.slice(2);
  try {
    if (!input || !output || extra.length) throw new Error("usage");
    console.log(JSON.stringify(await regrade(input, output)));
  } catch {
    console.error("Offline regrade failed; use a compatible synthetic documentation report and a NEW output path.");
    process.exitCode = 1;
  }
}
