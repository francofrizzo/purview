/**
 * Surfaces of the automatic analysis job: a chip for the PR list, and the
 * block at the top of the PR view's sidebar: a card while a PR has no
 * analysis to read yet, one line while a run redoes one it already has.
 *
 * The banner replaces what used to be a dead end ("no analysis — go run the
 * skill"): the job is startable, watchable and cancellable from here, and the
 * units simply appear when it finishes.
 */

import type { RefObject } from "react";
import { FloatingPanel } from "./FloatingPanel";
import { useAgentName } from "../api/hooks";
import type { AnalysisJob, AnalysisMetrics } from "../api/types";
import { capitalized } from "../lib/agentSelection";
import { IconClose, IconRefresh, IconSpinner, IconWarning } from "./icons";

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
  const run = m.run;
  if (run?.kind) rows.push(["Run", run.kind]);
  const model = run?.resolvedModel ?? run?.model;
  if (model) rows.push(["Model", run?.effort ? `${model} · ${run.effort}` : model]);
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

/** A finished analysis's run stats; none for a job from before they were recorded. */
export function analysisStats(job?: AnalysisJob | null): [string, string][] {
  return job?.status === "done" && job.metrics ? analysisStatsRows(job.metrics) : [];
}

/** The run stats, opened from the PR's ⋯ menu. */
export function AnalysisStatsPanel({
  rows,
  anchorRef,
  onClose,
}: {
  rows: [string, string][];
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  return (
    <FloatingPanel anchorRef={anchorRef} onClose={onClose} label="Analysis run stats" className="w-60 p-2">
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
    </FloatingPanel>
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
      data-tip={
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

/**
 * A live job's progress is either a phase ("fetching the PR head") or the tool
 * call running right now: what the agent is doing ("Reading the diff") and,
 * on a second line, what it is doing it to ("src/billing/charge.ts:120").
 */
export function isToolProgress(text: string): boolean {
  return /^[A-Z][A-Za-z]+(\s|$)/.test(text);
}

/** The two lines of a tool progress text; older servers sent one line, which stays whole. */
export function splitToolProgress(text: string): { doing: string; target?: string } {
  const at = text.indexOf("\n");
  if (at === -1) return { doing: text };
  const target = text.slice(at + 1).trim();
  return target ? { doing: text.slice(0, at), target } : { doing: text.slice(0, at) };
}

function ProgressText({ text }: { text: string }) {
  if (!isToolProgress(text)) return <>{text}</>;
  const { doing, target } = splitToolProgress(text);
  // One line: the verb never shrinks or wraps; the target gives way first.
  return (
    <span className="inline-flex max-w-full min-w-0 items-baseline gap-1.5 align-top" data-testid="analysis-tool-progress">
      <span className="flex-none whitespace-nowrap">{doing}</span>
      {target ? (
        <span className="min-w-0 truncate text-2xs" style={{ color: "var(--fg-faint)" }} title={target}>
          {target}
        </span>
      ) : null}
    </span>
  );
}

/** Banner copy, split out so it can be tested without rendering. */
export function archivedSkipText(
  revision: number,
  unplaced: number,
  scope: "pr" | "repo" = "pr",
): { title: string; detail: string } {
  return {
    title:
      scope === "repo"
        ? `This PR's repo is archived, so revision ${revision} wasn't analyzed.`
        : `This PR is archived, so revision ${revision} wasn't analyzed.`,
    detail:
      unplaced > 0
        ? `${unplaced} ${unplaced === 1 ? "hunk isn't" : "hunks aren't"} in any unit yet.`
        : "Some unit descriptions may not reflect its latest changes.",
  };
}

/**
 * A refresh of an archived PR landed new work, and auto-analysis skipped it
 * (archived PRs never spend on their own). Persisted server-side, so this
 * shows after a reload or from another tab too — without it the new hunks
 * just sit outside every unit and the PR looks unchanged.
 *
 * `scope: "repo"` is a PR archived only through its repo: the action then
 * analyzes this PR once and leaves the repo archived — unarchiving a whole
 * repo is the header chip's job, not a side effect of this button.
 */
export function ArchivedSkipBanner({
  revision,
  unplaced,
  working,
  error,
  scope = "pr",
  onUnarchiveAndAnalyze,
  onDismiss,
}: {
  revision: number;
  unplaced: number;
  working: boolean;
  error?: string | null;
  scope?: "pr" | "repo";
  onUnarchiveAndAnalyze: () => void;
  onDismiss: () => void;
}) {
  const text = archivedSkipText(revision, unplaced, scope);
  return (
    <section
      className="flex-none border-b px-3 py-2.5 text-xs"
      data-testid="archived-skip-banner"
      style={{ borderColor: "var(--border)" }}
    >
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 font-semibold leading-5" style={{ color: "var(--fg)" }}>
          {text.title}
        </span>
        <button
          type="button"
          className="flex-none rounded p-1 hover:bg-[var(--bg-hover)]"
          data-testid="archived-skip-dismiss"
          data-tip="Hide this note; the hunks stay under Not in any unit"
          aria-label="Dismiss"
          style={{ color: "var(--fg-faint)" }}
          disabled={working}
          onClick={onDismiss}
        >
          <IconClose width={10} height={10} />
        </button>
      </div>
      <p className="leading-5" style={{ color: "var(--fg-muted)" }}>
        {text.detail}
      </p>
      <button
        type="button"
        className="btn btn-primary mt-2"
        data-testid="archived-skip-analyze"
        disabled={working}
        onClick={onUnarchiveAndAnalyze}
      >
        {working ? <IconSpinner width={11} height={11} /> : <IconRefresh width={11} height={11} />}
        {working ? "starting…" : scope === "repo" ? "Analyze anyway" : "Unarchive and analyze"}
      </button>
      {error ? (
        <p className="mt-1 text-2xs" style={{ color: "var(--risk)" }}>
          {error}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The analysis's own state, at the top of the sidebar. With no units yet it
 * is a card: what is happening and the one thing to do about it. With units
 * on screen (`compact`) a run redoing them is one line, the live step and
 * cancel; a run that failed keeps that line, with the reason and retry, until
 * dismissed.
 */
export function AnalysisBanner({
  job,
  starting,
  cancelling,
  error,
  compact = false,
  onAnalyze,
  onCancel,
  onDismiss,
}: {
  job?: AnalysisJob | null;
  starting: boolean;
  cancelling: boolean;
  error?: string | null;
  compact?: boolean;
  onAnalyze: () => void;
  onCancel: () => void;
  /** compact and failed only: hide the line until the next run */
  onDismiss?: () => void;
}) {
  const status = job?.status;
  const live = status === "queued" || status === "running";
  const failed = status === "failed";
  // The harness of the last run on record; the default one before any.
  const agentName = useAgentName(job?.metrics?.run?.harness);
  const tone = failed ? "var(--risk)" : live ? "var(--accent)" : "var(--fg)";
  const title = live
    ? status === "queued"
      ? "Analysis queued"
      : "Analyzing this pull request…"
    : failed
      ? "Analysis failed"
      : status === "cancelled"
        ? "Analysis cancelled"
        : "Not analyzed yet";
  const retry = (
    <button type="button" className="btn btn-primary" data-testid="analysis-start" disabled={starting} onClick={onAnalyze}>
      <IconRefresh width={11} height={11} />
      {starting ? "starting…" : failed ? "retry analysis" : "analyze this PR"}
    </button>
  );
  const cancel = (
    <button type="button" className="btn" data-testid="analysis-cancel" disabled={cancelling} onClick={onCancel}>
      {cancelling ? "cancelling…" : "cancel"}
    </button>
  );
  const errorLine = error ? (
    <p className="mt-1 text-2xs" style={{ color: "var(--risk)" }}>
      {error}
    </p>
  ) : null;

  if (compact) {
    return (
      <section
        className="flex-none border-b px-3 py-1.5 text-xs"
        data-testid="analysis-banner"
        data-compact="true"
        style={{ borderColor: "var(--border)" }}
      >
        <div className="flex min-h-[26px] items-center gap-2">
          {live ? (
            <IconSpinner width={11} height={11} className="flex-none" style={{ color: "var(--accent)" }} />
          ) : (
            <IconWarning width={11} height={11} className="flex-none" style={{ color: "var(--risk)" }} />
          )}
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span className="flex-none font-medium" style={{ color: tone }}>
              {live ? (status === "queued" ? "Analysis queued" : "Analyzing") : "Analysis failed"}
            </span>
            {live && status === "running" && job?.progress ? (
              <span className="min-w-0 truncate" style={{ color: "var(--fg-muted)" }}>
                <ProgressText text={job.progress} />
              </span>
            ) : null}
          </span>
          {live ? (
            <button
              type="button"
              className="flex-none rounded px-1.5 py-0.5 text-2xs hover:bg-[var(--bg-hover)]"
              style={{ color: "var(--fg-muted)" }}
              data-testid="analysis-cancel"
              disabled={cancelling}
              onClick={onCancel}
            >
              {cancelling ? "cancelling…" : "cancel"}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="flex-none rounded px-1.5 py-0.5 text-2xs font-medium hover:bg-[var(--bg-hover)]"
                style={{ color: "var(--accent)" }}
                data-testid="analysis-start"
                disabled={starting}
                onClick={onAnalyze}
              >
                {starting ? "starting…" : "retry"}
              </button>
              {onDismiss ? (
                <button
                  type="button"
                  className="flex-none rounded p-1 hover:bg-[var(--bg-hover)]"
                  style={{ color: "var(--fg-faint)" }}
                  aria-label="Dismiss"
                  data-tip="Hide until the next run"
                  data-testid="analysis-dismiss"
                  onClick={onDismiss}
                >
                  <IconClose width={10} height={10} />
                </button>
              ) : null}
            </>
          )}
        </div>
        {failed ? (
          <p className="line-clamp-2 pl-[19px] text-2xs leading-4" style={{ color: "var(--fg-muted)" }} data-tip={job?.error}>
            {job?.error ?? "The run did not complete."}
          </p>
        ) : null}
        {errorLine}
      </section>
    );
  }

  return (
    <section
      className="flex-none border-b px-3 py-3 text-xs"
      data-testid="analysis-banner"
      style={{ borderColor: "var(--border)" }}
    >
      <div className="flex items-center gap-2">
        {status === "running" || starting ? (
          <IconSpinner width={12} height={12} className="flex-none" style={{ color: "var(--accent)" }} />
        ) : null}
        <span className="text-[13px] font-semibold" style={{ color: tone }}>
          {title}
        </span>
      </div>
      <p className="mt-1 leading-5" style={{ color: "var(--fg-muted)" }}>
        {live
          ? job?.progress
            ? <ProgressText text={job.progress} />
            : `${capitalized(agentName)} is reading the diff and grouping it into review units. They appear here as soon as it finishes.`
          : failed
            ? (job?.error ?? "The analysis run did not complete.")
            : status === "cancelled"
              ? "The run was cancelled before it produced any units."
              : `This pull request has no review units yet. Run the analysis to have ${agentName} read the diff and group it.`}
      </p>
      <div className="mt-2.5 flex items-center gap-1.5">{live ? cancel : retry}</div>
      {errorLine}
    </section>
  );
}
