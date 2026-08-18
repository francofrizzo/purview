import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { AnalysisJob, PrDetail } from "../api/types";
import { isJobLive } from "../api/types";
import { AnalysisChip } from "./Analysis";
import { ChatButton } from "./ChatPanel";
import { IconComment, IconMore, IconRefresh, IconSettings, IconUpload } from "./icons";

export function TopBar({
  detail,
  draftCount,
  pendingReview,
  refreshing,
  syncing,
  chatOpen,
  analysisJob,
  analysisStarting,
  analysisCancelling,
  onRefresh,
  onSync,
  onToggleDrafts,
  onToggleChat,
  onFinishReview,
  onAnalyze,
  onCancelAnalysis,
}: {
  detail: PrDetail;
  draftCount: number;
  /** true when a PENDING review exists on GitHub (undefined = not checked) */
  pendingReview?: boolean;
  refreshing: boolean;
  syncing: boolean;
  chatOpen: boolean;
  analysisJob?: AnalysisJob | null;
  analysisStarting: boolean;
  analysisCancelling: boolean;
  onRefresh: () => void;
  onSync: () => void;
  onToggleDrafts: () => void;
  onToggleChat: () => void;
  onFinishReview: () => void;
  onAnalyze: () => void;
  onCancelAnalysis: () => void;
}) {
  const { meta, state } = detail;
  const live = isJobLive(analysisJob);
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
        {/* Only interesting while the analysis is not a plain success. */}
        <AnalysisChip job={analysisJob} />
      </div>

      <div className="ml-auto flex flex-none items-center gap-1.5">
        <ChatButton open={chatOpen} onClick={onToggleChat} />
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
        <OverflowMenu
          items={[
            live
              ? {
                  label: analysisCancelling ? "cancelling analysis…" : "cancel analysis",
                  testId: "menu-cancel-analysis",
                  disabled: analysisCancelling,
                  onClick: onCancelAnalysis,
                }
              : {
                  label: analysisStarting ? "starting analysis…" : "analyze again",
                  testId: "menu-analyze-again",
                  disabled: analysisStarting,
                  hint: "Re-runs the automatic analysis for this revision.",
                  onClick: onAnalyze,
                },
          ]}
        />
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

interface MenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  hint?: string;
  testId?: string;
}

/** The rarely-used actions, kept out of the button row. */
function OverflowMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className="btn"
        data-testid="topbar-overflow"
        title="More actions"
        aria-label="More actions"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <IconMore width={12} height={12} />
      </button>
      {open ? (
        <div className="surface absolute right-0 top-7 z-40 w-60 rounded-md p-1 shadow-xl">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              data-testid={item.testId}
              disabled={item.disabled}
              className="w-full rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-50"
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
            >
              <span style={{ color: "var(--fg)" }}>{item.label}</span>
              {item.hint ? (
                <span className="mt-0.5 block text-2xs" style={{ color: "var(--fg-faint)" }}>
                  {item.hint}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
