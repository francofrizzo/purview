/**
 * Surfaces of the automatic analysis job: a chip for the PR list, and the
 * banner the PR view shows while a PR has no analysis to read yet.
 *
 * The banner replaces what used to be a dead end ("no analysis — go run the
 * skill"): the job is startable, watchable and cancellable from here, and the
 * units simply appear when it finishes.
 */

import type { AnalysisJob, AnalysisMetrics } from "../api/types";
import { IconRefresh, IconSpinner } from "./icons";

const STATUS_TEXT: Record<AnalysisJob["status"], string> = {
  queued: "queued",
  running: "analyzing…",
  done: "analyzed",
  failed: "analysis failed",
  cancelled: "analysis cancelled",
};

function toneFor(status: AnalysisJob["status"]): { fg: string; bg: string } {
  switch (status) {
    case "failed":
      return { fg: "var(--risk)", bg: "var(--risk-soft)" };
    case "cancelled":
      return { fg: "var(--fg-faint)", bg: "var(--bg-inset)" };
    case "done":
      return { fg: "var(--ok)", bg: "var(--bg-inset)" };
    default:
      return { fg: "var(--accent)", bg: "var(--accent-soft)" };
  }
}

/** "7.4 min · 62 turns · $1.83 · reads 4 / bash 31"; null when nothing to show. */
function formatMetricsLine(metrics: AnalysisMetrics): string | null {
  const parts: string[] = [];
  if (metrics.durationMs !== undefined) parts.push(`${(metrics.durationMs / 60_000).toFixed(1)} min`);
  if (metrics.turns !== undefined) parts.push(`${metrics.turns} turns`);
  if (metrics.costUsd !== undefined) parts.push(`$${metrics.costUsd.toFixed(2)}`);
  const reads = metrics.toolCalls.Read ?? 0;
  const bash = metrics.toolCalls.Bash ?? 0;
  if (reads || bash) parts.push(`reads ${reads} / bash ${bash}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** List-row chip. A finished job with metrics gets a quiet summary line instead. */
export function AnalysisChip({ job }: { job?: AnalysisJob | null }) {
  if (!job) return null;
  if (job.status === "done") {
    const line = job.metrics ? formatMetricsLine(job.metrics) : null;
    if (!line) return null;
    return (
      <span
        className="flex-none whitespace-nowrap text-2xs"
        data-testid="analysis-metrics"
        style={{ color: "var(--fg-faint)" }}
      >
        {line}
      </span>
    );
  }
  const tone = toneFor(job.status);
  const live = job.status === "queued" || job.status === "running";
  return (
    <span
      className="chip flex-none"
      data-testid="analysis-chip"
      title={
        job.status === "failed"
          ? (job.error ?? "The analysis failed")
          : (job.progress ?? STATUS_TEXT[job.status])
      }
      style={{ background: tone.bg, color: tone.fg }}
    >
      {job.status === "running" ? <IconSpinner width={9} height={9} /> : null}
      {live && job.status === "queued" ? <span>◔</span> : null}
      {STATUS_TEXT[job.status]}
    </span>
  );
}

export function AnalysisBanner({
  job,
  starting,
  cancelling,
  error,
  onAnalyze,
  onCancel,
}: {
  job?: AnalysisJob | null;
  starting: boolean;
  cancelling: boolean;
  error?: string | null;
  onAnalyze: () => void;
  onCancel: () => void;
}) {
  const status = job?.status;
  const live = status === "queued" || status === "running";
  const failed = status === "failed";
  const tone = failed ? "var(--risk)" : live ? "var(--accent)" : "var(--fg-muted)";
  const bg = failed ? "var(--risk-soft)" : live ? "var(--accent-soft)" : "var(--bg-inset)";

  return (
    <div
      className="flex-none border-b px-4 py-3"
      data-testid="analysis-banner"
      style={{ borderColor: "var(--border)", background: bg }}
    >
      <div className="flex items-center gap-2">
        {status === "running" || starting ? <IconSpinner width={12} height={12} /> : null}
        <span className="text-[13px] font-semibold" style={{ color: tone }}>
          {live
            ? status === "queued"
              ? "Analysis queued"
              : "Analyzing this pull request…"
            : failed
              ? "Analysis failed"
              : status === "cancelled"
                ? "Analysis cancelled"
                : "Not analyzed yet"}
        </span>
        <div className="ml-auto flex flex-none items-center gap-1.5">
          {live ? (
            <button
              type="button"
              className="btn"
              data-testid="analysis-cancel"
              disabled={cancelling}
              onClick={onCancel}
            >
              {cancelling ? "cancelling…" : "cancel"}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              data-testid="analysis-start"
              disabled={starting}
              onClick={onAnalyze}
            >
              <IconRefresh width={11} height={11} />
              {starting ? "starting…" : failed ? "retry analysis" : "analyze this PR"}
            </button>
          )}
        </div>
      </div>

      <p className="mt-1 max-w-4xl text-xs leading-5" style={{ color: "var(--fg-muted)" }}>
        {live
          ? (job?.progress ??
            "Claude is reading the diff and grouping it into review units. The units appear here as soon as it finishes.")
          : failed
            ? (job?.error ?? "The analysis run did not complete.")
            : status === "cancelled"
              ? "The run was cancelled before it produced any units."
              : "This pull request has no review units yet. Run the analysis to have Claude read the diff and group it."}
      </p>

      {error ? (
        <p className="mt-1 text-2xs" style={{ color: "var(--risk)" }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
