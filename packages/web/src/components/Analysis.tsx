/**
 * Surfaces of the automatic analysis job: a chip for the PR list, and the
 * banner the PR view shows while a PR has no analysis to read yet.
 *
 * The banner replaces what used to be a dead end ("no analysis — go run the
 * skill"): the job is startable, watchable and cancellable from here, and the
 * units simply appear when it finishes.
 */

import { useEffect, useRef, useState } from "react";
import type { AnalysisJob, AnalysisMetrics } from "../api/types";
import { IconRefresh, IconSpinner, IconStopwatch } from "./icons";

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

/** Rows of the stats popover; a row whose value is unknown is left out. */
export function analysisStatsRows(m: AnalysisMetrics): [string, string][] {
  const rows: [string, string][] = [];
  if (m.durationMs !== undefined) rows.push(["Duration", `${(m.durationMs / 60_000).toFixed(1)} min`]);
  if (m.turns !== undefined) rows.push(["Turns", String(m.turns)]);
  if (m.costUsd !== undefined) rows.push(["Cost", `$${m.costUsd.toFixed(2)}`]);
  if (m.usage?.output !== undefined) rows.push(["Output tokens", `${(m.usage.output / 1000).toFixed(1)}k`]);
  const tools = Object.entries(m.toolCalls)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name} ${n}`)
    .join(" · ");
  if (tools) rows.push(["Tool calls", tools]);
  return rows;
}

/**
 * A finished analysis's run stats, behind a small stopwatch trigger in the PR
 * header: there when you want them, silent otherwise. Nothing for a job with
 * no metrics (runs from before they were recorded).
 */
export function AnalysisStats({ job }: { job?: AnalysisJob | null }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  if (job?.status !== "done" || !job.metrics) return null;
  const rows = analysisStatsRows(job.metrics);
  if (rows.length === 0) return null;

  return (
    <span ref={wrapRef} className="relative inline-flex flex-none">
      <button
        type="button"
        data-testid="analysis-stats"
        aria-label="Analysis run stats"
        aria-expanded={open}
        title="Analysis run stats"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center"
        style={{ color: open ? "var(--fg)" : "var(--fg-faint)" }}
      >
        <IconStopwatch width={12} height={12} />
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Analysis run stats"
          className="surface absolute left-0 top-6 z-30 w-60 rounded-md p-2 elev-2"
        >
          <table className="w-full text-2xs tabular-nums">
            <tbody>
              {rows.map(([label, value]) => (
                <tr key={label}>
                  <td className="py-0.5 pr-3 align-top" style={{ color: "var(--fg-faint)" }}>
                    {label}
                  </td>
                  <td className="py-0.5 text-right" style={{ color: "var(--fg-muted)" }}>
                    {value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </span>
  );
}

/** List-row chip. Rendered only for a job that is not a plain success; a
 *  finished run's stats live behind AnalysisStats in the PR header. */
export function AnalysisChip({ job }: { job?: AnalysisJob | null }) {
  if (!job || job.status === "done") return null;
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
