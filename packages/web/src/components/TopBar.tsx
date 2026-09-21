import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { AnalysisJob, PrDetail } from "../api/types";
import { isJobLive } from "../api/types";
import { AnalysisChip } from "./Analysis";
import { AuthorAvatar } from "./AuthorAvatar";
import { StackedOnChip } from "./Chips";
import { stackedOnLink } from "../lib/stacked";
import { ChatButton } from "./ChatPanel";
import { useModalBackground } from "./Modal";
import {
  IconArrowLeft,
  IconCollapse,
  IconComment,
  IconExpand,
  IconMore,
  IconRefresh,
  IconSettings,
  IconUpload,
} from "./icons";

export function TopBar({
  detail,
  draftCount,
  pendingReview,
  refreshing,
  stale,
  staleTooltip,
  syncing,
  chatOpen,
  analysisJob,
  analysisStarting,
  analysisCancelling,
  hasAnalysis,
  exporting,
  sharing,
  importingFromPr,
  fullscreenVisible,
  fullscreenActive,
  onToggleFullscreen,
  onRefresh,
  onSync,
  onToggleDrafts,
  onToggleChat,
  onFinishReview,
  onAnalyze,
  onCancelAnalysis,
  onExportAnalysis,
  onImportFilePicked,
  onShareToPr,
  onImportFromPr,
}: {
  detail: PrDetail;
  draftCount: number;
  /** true when a PENDING review exists on GitHub (undefined = not checked) */
  pendingReview?: boolean;
  refreshing: boolean;
  /** upstream moved since the last fetch — marks the refresh button */
  stale?: boolean;
  staleTooltip?: string | null;
  syncing: boolean;
  chatOpen: boolean;
  analysisJob?: AnalysisJob | null;
  analysisStarting: boolean;
  analysisCancelling: boolean;
  /** whether there is an analysis on record to export / share */
  hasAnalysis: boolean;
  exporting: boolean;
  /** posting/updating the canonical analysis comment on the PR itself */
  sharing: boolean;
  /** importing the newest marked comment from the PR itself */
  importingFromPr: boolean;
  /** the Fullscreen API is supported and this isn't already a Home Screen app */
  fullscreenVisible?: boolean;
  fullscreenActive?: boolean;
  onToggleFullscreen?: () => void;
  onRefresh: () => void;
  onSync: () => void;
  onToggleDrafts: () => void;
  onToggleChat: () => void;
  onFinishReview: () => void;
  onAnalyze: () => void;
  onCancelAnalysis: () => void;
  onExportAnalysis: () => void;
  /** a file was picked from the "import analysis…" menu item */
  onImportFilePicked: (file: File) => void;
  /** "share analysis to PR" was picked — arms the confirm step (public write) */
  onShareToPr: () => void;
  /** "import analysis from PR" was picked — arms the confirm step (replaces the current analysis) */
  onImportFromPr: () => void;
}) {
  const importInputRef = useRef<HTMLInputElement>(null);
  const { meta, state } = detail;
  const live = isJobLive(analysisJob);
  // The gear opens settings over this PR view instead of leaving it.
  const background = useModalBackground();
  return (
    <header
      className="flex flex-none items-center gap-3 border-b px-3 py-2"
      style={{ borderColor: "var(--border)", background: "var(--bg-raised)" }}
    >
      <Link
        to="/"
        className="rounded p-1 transition-colors hover:bg-[var(--bg-hover)]"
        style={{ color: "var(--fg-faint)" }}
        title="All pull requests"
      >
        <IconArrowLeft width={12} height={12} />
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
        {meta.author ? (
          <span
            className="flex flex-none items-center gap-1 self-center text-2xs"
            style={{ color: "var(--fg-faint)" }}
            title={`Opened by ${meta.author}`}
          >
            <AuthorAvatar author={meta.author} url={meta.authorAvatarUrl} size={16} />
            {meta.author}
          </span>
        ) : null}
        <StackedOnChip link={stackedOnLink(meta, detail.basePrTracked === true)} />
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
        <button
          type="button"
          className="btn relative"
          data-testid="topbar-refresh"
          data-stale={stale ? "1" : undefined}
          title={staleTooltip ?? undefined}
          onClick={onRefresh}
          disabled={refreshing}
        >
          <IconRefresh width={11} height={11} />
          {refreshing ? "refreshing…" : "refresh"}
          {stale ? (
            <span
              data-testid="staleness-dot"
              aria-label="This PR changed upstream"
              className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full"
              style={{ background: "var(--accent)" }}
            />
          ) : null}
        </button>
        <button type="button" className="btn" onClick={onSync} disabled={syncing}>
          <IconUpload width={11} height={11} />
          {syncing ? "syncing…" : "sync"}
        </button>
        <input
          ref={importInputRef}
          type="file"
          accept="application/json"
          className="hidden"
          data-testid="import-analysis-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = ""; // lets the same file be re-picked later
            if (file) onImportFilePicked(file);
          }}
        />
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
            {
              label: exporting ? "exporting…" : "export analysis",
              testId: "menu-export-analysis",
              disabled: exporting || !hasAnalysis,
              hint: hasAnalysis
                ? "Download the current analysis to share with a teammate tracking this PR."
                : "No analysis yet — analyze first.",
              onClick: onExportAnalysis,
            },
            {
              label: "import analysis…",
              testId: "menu-import-analysis",
              hint: "Replaces the current analysis with one exported from a teammate's copy of this PR.",
              onClick: () => importInputRef.current?.click(),
            },
            {
              label: sharing ? "sharing…" : "share analysis to PR",
              testId: "menu-share-analysis-to-pr",
              disabled: sharing || !hasAnalysis,
              hint: hasAnalysis
                ? "Posts the current analysis as a comment on this PR, publicly on GitHub."
                : "No analysis yet — analyze first.",
              onClick: onShareToPr,
            },
            {
              label: importingFromPr ? "importing…" : "import analysis from PR",
              testId: "menu-import-analysis-from-pr",
              disabled: importingFromPr,
              hint: "Replaces the current analysis with the one shared as a comment on this PR.",
              onClick: onImportFromPr,
            },
          ]}
        />
        {fullscreenVisible ? (
          <button
            type="button"
            className="btn"
            title={fullscreenActive ? "Exit full screen" : "Full screen"}
            aria-label={fullscreenActive ? "Exit full screen" : "Full screen"}
            onClick={onToggleFullscreen}
          >
            {fullscreenActive ? (
              <IconCollapse width={12} height={12} />
            ) : (
              <IconExpand width={12} height={12} />
            )}
          </button>
        ) : null}
        <Link
          to="/settings"
          state={{ background }}
          className="btn"
          title="Settings"
          aria-label="Settings"
        >
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
        <div className="surface absolute right-0 top-7 z-40 w-60 rounded-md p-1 elev-2">
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
