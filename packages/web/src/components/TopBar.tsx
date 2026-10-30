import { EditorButton } from "./Editor";
import { Fragment, useCallback, useRef, useState } from "react";
import { TagChip, TagPopover } from "./TagPopover";
import { Link, useNavigate } from "react-router-dom";
import type { AnalysisJob, CommentAudience, PrDetail, RevisionInfo } from "../api/types";
import { isJobLive } from "../api/types";
import { AnalysisChip, AnalysisStatsPanel, analysisStats } from "./Analysis";
import { AuthorAvatar } from "./AuthorAvatar";
import { CiMark, DiffSizeStat, ReviewRequestAge, StackedOnChip } from "./Chips";
import { ReviewersMark, showsReviewers } from "./Reviewers";
import { RevisionMenu } from "./RevisionMenu";
import { diffTotals, formatAddedAt } from "../lib/prList";
import { formatRevisionSummary, revisionSummaryLines } from "../lib/revisionSummary";
import { stackedOnLink } from "../lib/stacked";
import { CopyPathButton } from "./DiffPane";
import { FloatingPanel } from "./FloatingPanel";
import { useModalBackground } from "./Modal";
import { OverflowMenu } from "./OverflowMenu";
import {
  IconArchive,
  IconArrowLeft,
  IconBolt,
  IconBranch,
  IconCheck,
  IconClose,
  IconCollapse,
  IconDownload,
  IconExpand,
  IconFileImport,
  IconInbox,
  IconKeyboard,
  IconRefresh,
  IconRewind,
  IconSettings,
  IconShare,
  IconStopwatch,
  IconUpload,
  IconDock,
  IconTag,
} from "./icons";

export function TopBar({
  detail,
  draftCount,
  dockOpen,
  dockBusy = false,
  onToggleDock,
  pendingReview,
  refreshing,
  stale,
  staleTooltip,
  syncing,
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
  onFinishReview,
  audience = "github",
  onAudienceChange,
  onAnalyze,
  onAnalyzeFresh,
  onCancelAnalysis,
  onExportAnalysis,
  onImportFilePicked,
  onShareToPr,
  onImportFromPr,
  onDiscardRevision,
  onResetDiscardRevision,
  highlightRevisions,
  onToggleHighlight,
  highlightAvailable,
  sinceReviewActive = false,
  onToggleSinceReview,
  archiving = false,
  onSetArchived,
  repoArchiving = false,
  onSetRepoArchived,
  viewOptions,
  onShowShortcuts,
}: {
  detail: PrDetail;
  draftCount: number;
  /** the right dock (comments, chat, review) is open */
  dockOpen: boolean;
  /** the chat is replying: the toggle shows a spinner */
  dockBusy?: boolean;
  /** open the dock on the last tab used, or close it */
  onToggleDock: () => void;
  /** true when a PENDING review exists on GitHub (undefined = not checked) */
  pendingReview?: boolean;
  refreshing: boolean;
  /** upstream moved since the last fetch — marks the refresh button */
  stale?: boolean;
  staleTooltip?: string | null;
  syncing: boolean;
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
  /** who new comments are for; only the agent case is shown here */
  audience?: CommentAudience;
  onAudienceChange?: (next: CommentAudience) => void;
  onFinishReview: () => void;
  onAnalyze: () => void;
  /** "analyze from scratch": the first-analysis flow, replacing every unit */
  onAnalyzeFresh: () => void;
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
  /** the changelog highlight, offered from the revision menu */
  highlightRevisions?: readonly number[];
  onToggleHighlight?: (revision: number) => void;
  highlightAvailable?: boolean;
  /** the "since your last review" filter is on */
  sinceReviewActive?: boolean;
  /** toggles it; omit to hide the chip */
  onToggleSinceReview?: () => void;
  archiving?: boolean;
  onSetArchived?: (archived: boolean) => void;
  repoArchiving?: boolean;
  /** archive state of the PR's whole repo (`detail.repoArchived`) */
  onSetRepoArchived?: (archived: boolean) => void;
  /** the view options button */
  viewOptions?: React.ReactNode;
  onShowShortcuts?: () => void;
}) {
  // The tag popover hangs under the chip when there is one, under the ⋯ menu otherwise.
  const tagChipRef = useRef<HTMLButtonElement>(null);
  const tagMenuRef = useRef<HTMLDivElement>(null);
  const [tagOpen, setTagOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const closeStats = useCallback(() => setStatsOpen(false), []);
  const stats = analysisStats(analysisJob);
  const importInputRef = useRef<HTMLInputElement>(null);
  const { meta, state } = detail;
  const live = isJobLive(analysisJob);
  // The gear opens settings over this PR view instead of leaving it.
  const background = useModalBackground();
  const navigate = useNavigate();
  return (
    <header
      className="flex flex-none flex-wrap items-center gap-x-2 gap-y-1.5 border-b px-2 py-2 sm:flex-nowrap sm:gap-3 sm:px-3"
      style={{
        borderColor: "var(--border)",
        // A faint wash of the theme's accent: the PR's header reads as its
        // own band above the diff, in every theme.
        background: "color-mix(in srgb, var(--accent) 7%, var(--bg-raised))",
      }}
    >
      <Link
        to="/"
        className="rounded p-1 transition-colors hover:bg-[var(--bg-hover)]"
        style={{ color: "var(--fg-faint)" }}
        aria-label="All pull requests"
        data-tip="All pull requests"
      >
        <IconArrowLeft width={12} height={12} />
      </Link>
      {/* Two lines: the title gets the whole width it needs, and the PR's
          facts sit quietly under it — the actions keep to the right. On a
          narrow screen the least useful facts step aside first. */}
      {/* Phone width: back + actions share the first row, and the title
          takes a full-width row of its own under them. */}
      <div className="order-last flex min-w-0 flex-1 basis-full flex-col justify-center gap-0.5 sm:order-none sm:basis-auto">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 sm:flex-nowrap">
          <a
            href={meta.url}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 max-w-full truncate text-[13px] font-semibold leading-snug hover:underline"
            style={{ color: "var(--fg)" }}
            data-testid="topbar-title"
            data-tip="Open on GitHub"
          >
            {meta.title ?? `${meta.owner}/${meta.repo}#${meta.number}`}
          </a>
          {/* Which PR, beside its name. Out of room it gives way before the
              title does, the number and the buttons last; at phone width it
              takes a line of its own. */}
          <span
            className="flex min-w-0 shrink-[999] items-center gap-1 text-2xs"
            style={{ color: "var(--fg-faint)" }}
            data-testid="topbar-repo"
          >
            <span className="min-w-0 truncate font-mono" data-tip={`${meta.owner}/${meta.repo}`}>
              {meta.owner}/{meta.repo}
            </span>
            <span className="flex-none font-mono" style={{ color: "var(--fg-muted)" }}>
              #{meta.number}
            </span>
            <CopyPathButton path={String(meta.number)} what="PR number" />
            {meta.headRef ? <BranchesButton head={meta.headRef} base={meta.baseRef} /> : null}
          </span>
        </div>
        <div
          className="flex min-w-0 items-center gap-x-3 overflow-hidden whitespace-nowrap text-2xs leading-4"
          style={{
            color: "var(--fg-faint)",
            // Out of room, the last fact fades out rather than being cut mid-word.
            maskImage: "linear-gradient(to right, black calc(100% - 2rem), transparent)",
            WebkitMaskImage: "linear-gradient(to right, black calc(100% - 2rem), transparent)",
          }}
          data-testid="topbar-meta"
        >
          {meta.author ? (
            <span className="flex flex-none items-center gap-1" data-tip={`Opened by ${meta.author}`}>
              <AuthorAvatar author={meta.author} url={meta.authorAvatarUrl} size={14} />
              <span className="hidden sm:inline">{meta.author}</span>
            </span>
          ) : null}
          <DiffSizeStat size={diffTotals(detail.files.files)} />
          {meta.tag ? (
            <button
              ref={tagChipRef}
              type="button"
              className="flex-none rounded transition-opacity hover:opacity-80"
              data-testid="header-tag"
              data-tip="Change the tag"
              aria-label={`Tag: ${meta.tag}. Change it`}
              onClick={() => setTagOpen(true)}
            >
              <TagChip tag={meta.tag} />
            </button>
          ) : null}
          <CiMark ci={meta.ci} interactive />
          {showsReviewers(detail.authoredByYou, meta.prState) ? (
            <ReviewersMark reviewers={meta.reviewers} className="flex-none" ring="var(--bg-raised)" />
          ) : null}
          {state.revisions && state.revisions.length > 1 ? (
            <RevisionMenu
              state={state}
              analysisLive={live}
              discarding={discardingRevision}
              error={discardRevisionError}
              onDiscard={onDiscardRevision}
              onResetError={onResetDiscardRevision}
              highlightRevisions={highlightRevisions}
              onToggleHighlight={onToggleHighlight}
              highlightAvailable={highlightAvailable}
            />
          ) : null}
          {detail.sinceReview && onToggleSinceReview ? (
            <SinceReviewChip
              since={detail.sinceReview}
              revisions={state.revisions}
              active={sinceReviewActive}
              onToggle={onToggleSinceReview}
            />
          ) : null}
          <ReviewRequestAge request={detail.reviewRequest} state={meta.prState} className="flex-none" />
          {meta.archived && onSetArchived ? (
            <button
              type="button"
              className="chip flex-none hover:!text-[var(--fg)]"
              data-testid="topbar-archived"
              disabled={archiving}
              data-tip="Archived: hidden on the home page, never analyzed on its own. Click to unarchive"
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
              className="chip flex-none hover:!text-[var(--fg)]"
              data-testid="topbar-archived"
              disabled={repoArchiving}
              data-tip={`The whole ${meta.owner}/${meta.repo} repo is archived. Click to unarchive it`}
              style={{ background: "var(--bg-inset)", color: "var(--fg-muted)" }}
              onClick={() => onSetRepoArchived(false)}
            >
              <IconArchive out width={10} height={10} />
              {repoArchiving ? "unarchiving repo…" : "repo archived · unarchive repo"}
            </button>
          ) : null}
          {/* Only interesting while the analysis is not a plain success. */}
          <AnalysisChip job={analysisJob} />
          <span className="hidden flex-none md:inline-flex">
            <StackedOnChip link={stackedOnLink(meta, detail.basePrTracked === true)} />
          </span>
        </div>
      </div>

      <div className="ml-auto flex flex-none items-center gap-1.5 sm:gap-2">
        {/* GitHub is where a comment goes unless said otherwise; the agent
            case is the one to be told about, and one click undoes it. */}
        {audience === "agent" && onAudienceChange ? (
          <button
            type="button"
            className="chip flex-none"
            data-testid="topbar-audience-agent-mode"
            data-tip="New comments are notes for a coding agent. Click for GitHub review comments"
            data-tip-key="a"
            style={{ background: "var(--agent-soft)", color: "var(--agent)" }}
            onClick={() => onAudienceChange("github")}
          >
            notes for agent
          </button>
        ) : null}
        {viewOptions}
        <EditorButton prKey={detail.key} />
        {/* The right dock (comments, chat, review) has one toggle; its tabs
            take over once it is open. The badge is the unsent comments. */}
        <button
          type="button"
          className="btn relative"
          onClick={onToggleDock}
          data-tip={
            dockOpen
              ? "Close the panel"
              : dockBusy
                ? "The chat is answering · comments, chat and review"
                : "Comments, chat and review"
          }
          data-tip-key="m c r"
          aria-label="Comments, chat and review"
          aria-pressed={dockOpen}
          data-testid="topbar-comments"
          style={dockOpen ? { background: "var(--accent-soft)", color: "var(--accent)" } : undefined}
        >
          <IconDock width={12} height={12} />
          {draftCount ? (
            <span
              className="rounded-full px-1 text-2xs"
              style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
            >
              {draftCount}
            </span>
          ) : null}
          {/* The chat at work, while the panel is shut (open, its tab says
              so). A dot on the corner, so the button never changes width
              and nothing beside it moves. */}
          {dockBusy && !dockOpen ? (
            <span
              className="absolute -right-0.5 -top-0.5 h-2 w-2 animate-pulse rounded-full"
              style={{ background: "var(--accent)", boxShadow: "0 0 0 2px var(--bg)" }}
              data-testid="topbar-chat-busy"
            />
          ) : null}
        </button>
        {/* Quiet until GitHub moved: then it says so, and why on hover. */}
        <button
          type="button"
          className="btn"
          data-testid="topbar-refresh"
          data-stale={stale ? "1" : undefined}
          data-tip={refreshing ? "Refreshing…" : (staleTooltip ?? "Refresh from GitHub")}
          aria-label="Refresh"
          onClick={onRefresh}
          disabled={refreshing}
          style={stale ? { color: "var(--accent)", borderColor: "var(--accent)" } : undefined}
        >
          <IconRefresh width={12} height={12} className={refreshing ? "animate-spin" : undefined} />
          {stale ? <span className="hidden md:inline">new commits</span> : null}
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
        <div ref={tagMenuRef} className="flex flex-none">
        <OverflowMenu
          items={[
            { label: meta.tag ? "change tag…" : "tag…", testId: "header-tag-menu", icon: <IconTag width={12} height={12} />, onClick: () => setTagOpen(true) },
            {
              label: syncing ? "syncing…" : "sync to GitHub",
              icon: <IconUpload width={12} height={12} />,
              testId: "menu-sync",
              disabled: syncing,
              hint: "Push viewed files and comments to GitHub.",
              onClick: onSync,
            },
            ...(onSetArchived
              ? [
                  {
                    label: meta.archived ? "unarchive" : "archive",
                    icon: <IconArchive out={meta.archived} width={12} height={12} />,
                    testId: "menu-archive",
                    disabled: archiving,
                    hint: meta.archived
                      ? "Back in the PR list; new revisions are analyzed automatically again."
                      : "Hide it in the PR list and stop automatic analyses. Nothing changes on GitHub.",
                    onClick: () => onSetArchived(!meta.archived),
                  },
                ]
              : []),
            ...(live
              ? [
                  {
                    label: analysisCancelling ? "cancelling analysis…" : "cancel analysis",
                    dividerBefore: true,
                    icon: <IconClose width={12} height={12} />,
                    testId: "menu-cancel-analysis",
                    disabled: analysisCancelling,
                    onClick: onCancelAnalysis,
                  },
                ]
              : [
                  {
                    label: analysisStarting ? "starting analysis…" : "analyze again",
                    dividerBefore: true,
                    icon: <IconBolt width={12} height={12} />,
                    testId: "menu-analyze-again",
                    disabled: analysisStarting,
                    hint: "Re-runs the automatic analysis for this revision; what is already classified stays.",
                    onClick: onAnalyze,
                  },
                  {
                    label: "analyze from scratch",
                    icon: <IconRewind width={12} height={12} />,
                    testId: "menu-analyze-fresh",
                    disabled: analysisStarting || !hasAnalysis,
                    hint: hasAnalysis
                      ? "Drops every unit and the summary, then analyzes this revision again from nothing."
                      : "No analysis yet — analyze first.",
                    onClick: onAnalyzeFresh,
                  },
                ]),
            ...(stats.length
              ? [
                  {
                    label: "analysis stats",
                    icon: <IconStopwatch width={12} height={12} />,
                    testId: "menu-analysis-stats",
                    hint: "What the last analysis run took.",
                    onClick: () => setStatsOpen(true),
                  },
                ]
              : []),
            {
              label: exporting ? "exporting…" : "export analysis to file",
              dividerBefore: true,
              icon: <IconDownload width={12} height={12} />,
              testId: "menu-export-analysis",
              disabled: exporting || !hasAnalysis,
              hint: hasAnalysis
                ? "Download the current analysis to share with a teammate tracking this PR."
                : "No analysis yet — analyze first.",
              onClick: onExportAnalysis,
            },
            {
              label: "import analysis from file…",
              icon: <IconFileImport width={12} height={12} />,
              testId: "menu-import-analysis",
              hint: "Replaces the current analysis with one exported from a teammate's copy of this PR.",
              onClick: () => importInputRef.current?.click(),
            },
            {
              label: sharing ? "sharing…" : "share analysis to PR",
              icon: <IconShare width={12} height={12} />,
              testId: "menu-share-analysis-to-pr",
              disabled: sharing || !hasAnalysis,
              hint: hasAnalysis
                ? "Posts the current analysis as a comment on this PR, publicly on GitHub."
                : "No analysis yet — analyze first.",
              onClick: onShareToPr,
            },
            {
              label: importingFromPr ? "importing…" : "import analysis from PR",
              icon: <IconInbox width={12} height={12} />,
              testId: "menu-import-analysis-from-pr",
              disabled: importingFromPr,
              hint: "Replaces the current analysis with the one shared as a comment on this PR.",
              onClick: onImportFromPr,
            },
            // App-level, not about this PR: last.
            ...(fullscreenVisible && onToggleFullscreen
              ? [
                  {
                    label: fullscreenActive ? "exit full screen" : "full screen",
                    dividerBefore: true,
                    icon: fullscreenActive ? <IconCollapse width={12} height={12} /> : <IconExpand width={12} height={12} />,
                    testId: "menu-fullscreen",
                    onClick: onToggleFullscreen,
                  },
                ]
              : []),
            ...(onShowShortcuts
              ? [
                  {
                    label: "keyboard shortcuts",
                    dividerBefore: !(fullscreenVisible && onToggleFullscreen),
                    icon: <IconKeyboard width={12} height={12} />,
                    testId: "menu-shortcuts",
                    hint: "Or press ?",
                    onClick: onShowShortcuts,
                  },
                ]
              : []),
            {
              label: "repo settings",
              dividerBefore: !(fullscreenVisible && onToggleFullscreen) && !onShowShortcuts,
              icon: <IconSettings width={12} height={12} />,
              testId: "menu-repo-settings",
              hint: `Shared by every PR in ${meta.owner}/${meta.repo}.`,
              onClick: () =>
                navigate(`/repo/${meta.host}/${meta.owner}/${meta.repo}/settings`, {
                  state: { background },
                }),
            },
            {
              label: "app settings",
              icon: <IconSettings width={12} height={12} />,
              hint: "Theme, fonts, diff defaults; for every repo.",
              onClick: () => navigate("/settings", { state: { background } }),
            },
          ]}
        />
        </div>
        <button
          type="button"
          className="btn flex-none font-semibold hover:brightness-110"
          style={{ background: "var(--accent)", borderColor: "var(--accent)", color: "var(--bg)" }}
          data-testid="topbar-finish-review"
          onClick={onFinishReview}
        >
          <IconCheck width={12} height={12} />
          {/* One flex item, so the button's gap never lands between the words. */}
          <span>
            finish<span className="hidden sm:inline"> review</span>
          </span>
          {pendingReview ? (
            <span
              className="rounded-full px-1.5 text-2xs"
              // On the solid accent button the warn pair has nothing to stand
              // on; the badge borrows the button's own ink, inverted.
              style={{ background: "var(--bg)", color: "var(--accent)" }}
              data-tip="You have a pending review on GitHub"
            >
              pending
            </span>
          ) : null}
        </button>
      </div>
      {tagOpen ? (
        <TagPopover
          prKey={detail.key}
          current={meta.tag}
          anchorRef={meta.tag ? tagChipRef : tagMenuRef}
          onClose={() => setTagOpen(false)}
        />
      ) : null}
      {statsOpen ? <AnalysisStatsPanel rows={stats} anchorRef={tagMenuRef} onClose={closeStats} /> : null}
    </header>
  );
}

/**
 * The PR's two branches behind one icon: a tooltip that stays while the
 * pointer is on it, so each branch can be copied. A press opens it too, for
 * touch and the keyboard.
 */
function BranchesButton({ head, base }: { head: string; base?: string }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const leaving = useRef<number | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const stay = () => {
    if (leaving.current !== null) window.clearTimeout(leaving.current);
    leaving.current = null;
  };
  const leave = () => {
    stay();
    leaving.current = window.setTimeout(close, 160);
  };
  const rows: [string, string][] = base ? [["base", base], ["head", head]] : [["head", head]];
  return (
    <span ref={anchorRef} className="inline-flex flex-none" onMouseLeave={leave}>
      <button
        type="button"
        className="inline-flex items-center hover:!text-[var(--fg)]"
        style={{ color: open ? "var(--fg)" : "var(--fg-faint)" }}
        aria-label="Branches"
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="topbar-branches"
        onMouseEnter={() => {
          stay();
          setOpen(true);
        }}
        onClick={() => setOpen(true)}
      >
        <IconBranch width={12} height={12} />
      </button>
      {open ? (
        <FloatingPanel anchorRef={anchorRef} onClose={close} label="Branches" className="text-2xs">
          <div
            className="grid max-w-[32rem] grid-cols-[max-content_minmax(0,1fr)_max-content] items-center gap-x-2 gap-y-1 p-2"
            data-testid="topbar-branches-panel"
            onMouseEnter={stay}
            onMouseLeave={leave}
          >
            {rows.map(([which, name]) => (
              <Fragment key={which}>
                <span style={{ color: "var(--fg-faint)" }}>{which}</span>
                <span className="truncate font-mono" style={{ color: "var(--fg)" }} data-tip={name}>
                  {name}
                </span>
                <CopyPathButton path={name} what={`${which} branch`} />
              </Fragment>
            ))}
          </div>
        </FloatingPanel>
      ) : null}
    </span>
  );
}

export { OverflowMenu, type MenuItem } from "./OverflowMenu";

const VERDICT_WORD: Record<string, string> = {
  APPROVE: "approved",
  REQUEST_CHANGES: "changes requested",
  COMMENT: "commented",
};

/**
 * "since review r2 · 3": the PR-level filter down to the hunks that changed
 * after the reader's last submitted review. Shown only once the PR has moved
 * past that review's revision; with nothing changed it just says so.
 */
function SinceReviewChip({
  since,
  revisions,
  active,
  onToggle,
}: {
  since: NonNullable<PrDetail["sinceReview"]>;
  /** the PR's revisions: the ones after the review say in the tip what they changed */
  revisions?: readonly RevisionInfo[];
  active: boolean;
  onToggle: () => void;
}) {
  const n = since.changedHunkIds.length;
  const when = `your review on r${since.revision} (${VERDICT_WORD[since.event] ?? since.event.toLowerCase()}, ${formatAddedAt(since.ts)})`;
  // What landed since, newest first ("r3 · …"), so the chip says what the
  // reader missed, not only how many hunks moved.
  const sinceThen = revisionSummaryLines(revisions, since.revision).map(formatRevisionSummary);
  const sinceNote = sinceThen.length > 0 ? ` Since then: ${sinceThen.join("; ")}` : "";
  if (n === 0) {
    return (
      <span
        className="hidden flex-none self-center text-2xs md:inline"
        style={{ color: "var(--fg-faint)" }}
        data-tip={`No hunk changed since ${when}: the new revision only moved the base or context.${sinceNote}`}
      >
        no changes since your review
      </span>
    );
  }
  return (
    <button
      type="button"
      className="chip flex-none self-center transition-colors"
      data-testid="since-review-toggle"
      aria-pressed={active}
      data-tip={
        active
          ? `Showing only the ${n} hunk${n === 1 ? "" : "s"} changed since ${when}. Click to show everything.${sinceNote}`
          : `Show only the ${n} hunk${n === 1 ? "" : "s"} changed since ${when}.${sinceNote}`
      }
      style={
        active
          ? { background: "var(--accent)", color: "var(--bg)" }
          : { background: "var(--accent-soft)", color: "var(--accent)" }
      }
      onClick={onToggle}
    >
      since review r{since.revision}
      <span className="tabular-nums" style={{ opacity: 0.75 }}>
        · {n}
      </span>
    </button>
  );
}
