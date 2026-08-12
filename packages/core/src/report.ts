import { formatMigrationReport } from "./migration.js";
import { unitProgress } from "./reducer.js";
import type { MigrationReport, State } from "./schemas.js";

function bar(viewed: number, total: number): string {
  if (total === 0) return "[----------]";
  const filled = Math.round((viewed / total) * 10);
  return "[" + "#".repeat(filled) + "-".repeat(10 - filled) + "]";
}

/** The human-readable `reviewer-state report` output. */
export function formatReport(
  state: State,
  migration?: MigrationReport,
): string {
  const out: string[] = [];
  if (state.pr) {
    out.push(
      `${state.pr.owner}/${state.pr.repo}#${state.pr.number}` +
        (state.pr.title ? ` — ${state.pr.title}` : ""),
    );
    out.push(state.pr.url);
  }
  const rev = state.revisions.find((r) => r.revision === state.currentRevision);
  if (rev) {
    out.push(
      `revision ${rev.revision}${rev.baseOnly ? " (base moved only)" : ""}  ` +
        `head=${rev.headSha.slice(0, 8)} base=${rev.baseSha.slice(0, 8)} ` +
        `mergeBase=${rev.mergeBase.slice(0, 8)}`,
    );
  }
  out.push("");

  if (state.summary) {
    out.push("Summary");
    out.push("  " + state.summary.split("\n").join("\n  "));
    out.push("");
  }

  const mig = migration ?? state.lastMigration;
  if (mig) {
    out.push(formatMigrationReport(mig));
    out.push("");
  }

  const hunkTotal = Object.keys(state.hunks).length;
  const hunkViewed = Object.values(state.hunks).filter((h) => h.viewed).length;
  const changed = Object.values(state.hunks).filter(
    (h) => h.changedSinceViewed,
  ).length;
  out.push(
    `Progress ${bar(hunkViewed, hunkTotal)} ${hunkViewed}/${hunkTotal} hunks viewed` +
      (changed > 0 ? `, ${changed} changed since viewed` : ""),
  );
  out.push("");

  const progress = unitProgress(state);
  if (progress.length === 0) {
    out.push("No analysis yet (run set-analysis).");
  } else {
    out.push("Units");
    for (const p of progress) {
      out.push(
        `  ${p.complete ? "x" : " "} ${bar(p.viewed, p.total)} ` +
          `${p.viewed}/${p.total}  [${p.attention}/${p.kind}] ${p.unitId}: ${p.title}` +
          (p.changed ? "  (changed)" : ""),
      );
    }
  }

  const assigned = new Set([
    ...state.units.flatMap((u) => u.hunkIds),
    ...state.unassignedHunkIds,
  ]);
  const unclassified = Object.keys(state.hunks).filter((id) => !assigned.has(id));
  if (unclassified.length > 0) {
    out.push("");
    out.push(`Needs classification (${unclassified.length}):`);
    for (const id of unclassified) {
      const file =
        state.files.find((f) => f.hunkIds.includes(id))?.path ?? "?";
      const st = state.hunks[id];
      out.push(
        `  ${id}  ${file}` +
          (st?.defaultAttentionWhy ? `  (default skip: ${st.defaultAttentionWhy})` : ""),
      );
    }
  }

  if (state.archived.length > 0) {
    out.push("");
    out.push(`Archived hunks (${state.archived.length}):`);
    for (const a of state.archived.slice(-20)) {
      out.push(
        `  ${a.hunkId}  ${a.file}  (r${a.archivedAtRevision}${a.wasViewed ? ", was viewed" : ""})`,
      );
    }
  }

  const files = state.files;
  const filesViewed = files.filter((f) => f.viewed).length;
  out.push("");
  out.push(`Files ${filesViewed}/${files.length} fully viewed`);
  return out.join("\n");
}
