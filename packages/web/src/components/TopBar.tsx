import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import type { AnalysisJob, PrDetail } from "../api/types";
import { isJobLive } from "../api/types";
import { AnalysisChip, AnalysisStats } from "./Analysis";
import { AuthorAvatar } from "./AuthorAvatar";
import { ReviewRequestAge, StackedOnChip } from "./Chips";
import { RevisionMenu } from "./RevisionMenu";
import { stackedOnLink } from "../lib/stacked";
import { ChatButton } from "./ChatPanel";
import { CopyPathButton } from "./DiffPane";
import { useModalBackground } from "./Modal";
import {
  IconArchive,
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
  discardingRevision,
  discardRevisionError,
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
  onDiscardRevision,
  onResetDiscardRevision,
  archiving = false,
  onSetArchived,
  repoArchiving = false,
  onSetRepoArchived,
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
  discardingRevision: boolean;
  /** the server's refusal of the last discard, shown in the "rev N" popover */
  discardRevisionError: string | null;
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
  onDiscardRevision: (revision: number) => void;
  onResetDiscardRevision: () => void;
  archiving?: boolean;
  onSetArchived?: (archived: boolean) => void;
  repoArchiving?: boolean;
  /** archive state of the PR's whole repo (`detail.repoArchived`) */
  onSetRepoArchived?: (archived: boolean) => void;
}) {
  const importInputRef = useRef<HTMLInputElement>(null);
  const { meta, state } = detail;
  const live = isJobLive(analysisJob);
  // The gear opens settings over this PR view instead of leaving it.
  const background = useModalBackground();
  const navigate = useNavigate();
  return (
    <header
      className="flex flex-none items-center gap-2 border-b px-2 py-2 sm:gap-3 sm:px-3"
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
      {/* Narrow screens keep the title (truncating) and the revision; the rest
          of the meta steps aside by width, least useful first. */}
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <a
          href={meta.url}
          target="_blank"
          rel="noreferrer"
          className="min-w-[3rem] truncate text-sm sm:min-w-[7rem] font-semibold hover:underline"
          style={{ color: "var(--fg)" }}
        >
          {meta.title ?? `${meta.owner}/${meta.repo}#${meta.number}`}
        </a>
        <span
          className="hidden flex-none font-mono text-2xs lg:inline"
          style={{ color: "var(--fg-faint)" }}
        >
          {meta.owner}/{meta.repo}#{meta.number} ·
        </span>
        {meta.headRef ? (
          <span
            className="hidden min-w-0 max-w-[16rem] flex-shrink items-center gap-1 self-center 2xl:flex"
            title={meta.baseRef ? `${meta.headRef} → ${meta.baseRef}` : meta.headRef}
            data-testid="topbar-branch"
          >
            <span className="truncate font-mono text-2xs" style={{ color: "var(--fg-muted)" }}>
              {meta.headRef}
            </span>
            <CopyPathButton path={meta.headRef} what="branch name" />
            <span className="font-mono text-2xs" style={{ color: "var(--fg-faint)" }}>
              ·
            </span>
          </span>
        ) : null}
        <RevisionMenu
          state={state}
          analysisLive={live}
          discarding={discardingRevision}
          error={discardRevisionError}
          onDiscard={onDiscardRevision}
          onResetError={onResetDiscardRevision}
        />
        {meta.author ? (
          <span
            className="hidden flex-none items-center gap-1 self-center text-2xs sm:flex"
            style={{ color: "var(--fg-faint)" }}
            title={`Opened by ${meta.author}`}
          >
            <AuthorAvatar author={meta.author} url={meta.authorAvatarUrl} size={16} />
            <span className="hidden 2xl:inline">{meta.author}</span>
          </span>
        ) : null}
        <span className="hidden flex-none self-center lg:inline-flex">
          <StackedOnChip link={stackedOnLink(meta, detail.basePrTracked === true)} />
        </span>
        <ReviewRequestAge
          request={detail.reviewRequest}
          state={meta.prState}
          className="hidden flex-none self-center text-2xs xl:inline"
        />
        {meta.archived && onSetArchived ? (
          <button
            type="button"
            className="chip flex-none self-center hover:!text-[var(--fg)]"
            data-testid="topbar-archived"
            disabled={archiving}
            title="Archived: hidden in the PR list and never analyzed automatically. Click to unarchive."
            style={{ background: "var(--bg-inset)", color: "var(--fg-muted)" }}
            onClick={() => onSetArchived(false)}
          >
            <IconArchive out width={10} height={10} />
            {archiving ? "unarchiving…" : "archived · unarchive"}
          </button>
        ) : detail.repoArchived && onSetRepoArchived ? (
          // Archived through its repo, not on its own: the way out is the
          // repo's unarchive, which restores every PR in it as it was.
          <button
            type="button"
            className="chip flex-none self-center hover:!text-[var(--fg)]"
            data-testid="topbar-archived"
            disabled={repoArchiving}
            title={`The whole ${meta.owner}/${meta.repo} repo is archived, so this PR is never analyzed automatically. Click to unarchive the repo.`}
            style={{ background: "var(--bg-inset)", color: "var(--fg-muted)" }}
            onClick={() => onSetRepoArchived(false)}
          >
            <IconArchive out width={10} height={10} />
            {repoArchiving ? "unarchiving repo…" : "repo archived · unarchive repo"}
          </button>
        ) : null}
        {/* Only interesting while the analysis is not a plain success. */}
        <AnalysisChip job={analysisJob} />
        <AnalysisStats job={analysisJob} />
      </div>

      <div className="ml-auto flex flex-none items-center gap-1 sm:gap-1.5">
        <ChatButton open={chatOpen} onClick={onToggleChat} />
        <button
          type="button"
          className="btn"
          onClick={onToggleDrafts}
          title="Comments"
          aria-label="Comments"
        >
          <IconComment width={11} height={11} />
          <span className="hidden xl:inline">comments</span>
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
          title={staleTooltip ?? "Refresh"}
          aria-label="Refresh"
          onClick={onRefresh}
          disabled={refreshing}
        >
          <IconRefresh width={11} height={11} />
          <span className="hidden xl:inline">{refreshing ? "refreshing…" : "refresh"}</span>
          {stale ? (
            <span
              data-testid="staleness-dot"
              aria-label="This PR changed upstream"
              className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full"
              style={{ background: "var(--accent)" }}
            />
          ) : null}
        </button>
        <button
          type="button"
          className="btn hidden sm:inline-flex"
          onClick={onSync}
          disabled={syncing}
          title="Sync viewed files and comments to GitHub"
          aria-label="Sync"
        >
          <IconUpload width={11} height={11} />
          <span className="hidden xl:inline">{syncing ? "syncing…" : "sync"}</span>
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
            // Phone width: the row keeps chat, comments, refresh and finish;
            // these move in here.
            {
              label: syncing ? "syncing…" : "sync",
              narrowOnly: true,
              disabled: syncing,
              hint: "Push viewed files and comments to GitHub.",
              onClick: onSync,
            },
            ...(fullscreenVisible && onToggleFullscreen
              ? [
                  {
                    label: fullscreenActive ? "exit full screen" : "full screen",
                    narrowOnly: true,
                    onClick: onToggleFullscreen,
                  },
                ]
              : []),
            {
              label: "settings",
              narrowOnly: true,
              onClick: () => navigate("/settings", { state: { background } }),
            },
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
            ...(onSetArchived
              ? [
                  {
                    label: meta.archived ? "unarchive" : "archive",
                    testId: "menu-archive",
                    disabled: archiving,
                    hint: meta.archived
                      ? "Back in the PR list; new revisions are analyzed automatically again."
                      : "Hide it in the PR list and stop automatic analyses. Nothing changes on GitHub.",
                    onClick: () => onSetArchived(!meta.archived),
                  },
                ]
              : []),
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
            className="btn hidden sm:inline-flex"
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
          className="btn hidden sm:inline-flex"
          title="Settings"
          aria-label="Settings"
        >
          <IconSettings width={12} height={12} />
        </Link>
        <button type="button" className="btn btn-primary" onClick={onFinishReview}>
          finish<span className="hidden sm:inline"> review</span>
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

export interface MenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  hint?: string;
  testId?: string;
  /** listed only at phone width, where its button leaves the row */
  narrowOnly?: boolean;
}

/**
 * The rarely-used actions, kept out of the button row. Also the repo group
 * header's ⋯ in the PR list, which passes its own test id, label and a
 * smaller trigger.
 */
export function OverflowMenu({
  items,
  testId = "topbar-overflow",
  label = "More actions",
  buttonClassName = "btn",
  buttonStyle,
  fixed = false,
}: {
  items: MenuItem[];
  testId?: string;
  label?: string;
  buttonClassName?: string;
  buttonStyle?: React.CSSProperties;
  /**
   * Render the menu in a portal, positioned against the viewport, so an
   * ancestor's `overflow: hidden` or opacity (a PR-list repo card, dimmed
   * when archived) cannot clip or fade it. It closes on scroll then, rather
   * than drifting away from its button.
   */
  fixed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !fixed) return;
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open, fixed]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); // claimed: the page's own Escape leaves it alone
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const menu = (
    <div
      ref={menuRef}
      className={`surface z-40 w-60 rounded-md p-1 elev-2 ${fixed ? "fixed" : "absolute right-0 top-7"}`}
      style={fixed && anchor ? { top: anchor.top, right: anchor.right } : undefined}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          data-testid={item.testId}
          disabled={item.disabled}
          className={`w-full rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-50 ${
            item.narrowOnly ? "sm:hidden" : ""
          }`}
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
  );

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className={buttonClassName}
        data-testid={testId}
        title={label}
        aria-label={label}
        aria-expanded={open}
        style={buttonStyle}
        onClick={(e) => {
          if (fixed) {
            const r = e.currentTarget.getBoundingClientRect();
            setAnchor({ top: r.bottom + 4, right: window.innerWidth - r.right });
          }
          setOpen((v) => !v);
        }}
      >
        <IconMore width={12} height={12} />
      </button>
      {open ? (fixed ? createPortal(menu, document.body) : menu) : null}
    </div>
  );
}
