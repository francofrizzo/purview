import { Link } from "react-router-dom";
import type { PrDetail } from "../api/types";
import { IconComment, IconRefresh, IconSettings, IconUpload } from "./icons";

export function TopBar({
  detail,
  draftCount,
  pendingReview,
  refreshing,
  syncing,
  summaryOpen,
  onToggleSummary,
  onRefresh,
  onSync,
  onToggleDrafts,
  onFinishReview,
}: {
  detail: PrDetail;
  draftCount: number;
  /** true when a PENDING review exists on GitHub (undefined = not checked) */
  pendingReview?: boolean;
  refreshing: boolean;
  syncing: boolean;
  summaryOpen: boolean;
  onToggleSummary: () => void;
  onRefresh: () => void;
  onSync: () => void;
  onToggleDrafts: () => void;
  onFinishReview: () => void;
}) {
  const { meta, state } = detail;
  return (
    <header
      className="flex flex-none items-center gap-3 border-b px-3 py-2"
      style={{ borderColor: "var(--border)", background: "var(--bg-raised)" }}
    >
      <Link to="/" className="text-xs" style={{ color: "var(--fg-faint)" }} title="All pull requests">
        ←
      </Link>
      <div className="flex min-w-0 items-baseline gap-2">
        <a
          href={meta.url}
          target="_blank"
          rel="noreferrer"
          className="truncate text-sm font-semibold hover:underline"
          style={{ color: "var(--fg)" }}
        >
          {meta.title ?? `${meta.owner}/${meta.repo}#${meta.number}`}
        </a>
        <span className="flex-none font-mono text-2xs" style={{ color: "var(--fg-faint)" }}>
          {meta.owner}/{meta.repo}#{meta.number} · rev {state.revision}
          {state.baseOnly ? " (base only)" : ""}
        </span>
      </div>

      <div className="ml-auto flex flex-none items-center gap-1.5">
        <button type="button" className="btn" onClick={onToggleSummary}>
          {summaryOpen ? "hide summary" : "summary"}
        </button>
        <button type="button" className="btn" onClick={onToggleDrafts}>
          <IconComment width={11} height={11} />
          comments
          {draftCount ? (
            <span
              className="rounded-full px-1 text-2xs"
              style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
            >
              {draftCount}
            </span>
          ) : null}
        </button>
        <button type="button" className="btn" onClick={onRefresh} disabled={refreshing}>
          <IconRefresh width={11} height={11} />
          {refreshing ? "refreshing…" : "refresh"}
        </button>
        <button type="button" className="btn" onClick={onSync} disabled={syncing}>
          <IconUpload width={11} height={11} />
          {syncing ? "syncing…" : "sync"}
        </button>
        <Link to="/settings" className="btn" title="Settings" aria-label="Settings">
          <IconSettings width={12} height={12} />
        </Link>
        <button type="button" className="btn btn-primary" onClick={onFinishReview}>
          finish review
          {pendingReview ? (
            <span
              className="rounded-full px-1 text-2xs"
              style={{ background: "var(--warn-soft)", color: "var(--warn)" }}
              title="You have a pending review on GitHub"
            >
              pending
            </span>
          ) : null}
        </button>
      </div>
    </header>
  );
}
