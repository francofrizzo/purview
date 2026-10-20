import { EditorButton } from "./Editor";
import { useRef, useState } from "react";
import { TagChip, TagPopover } from "./TagPopover";
import { Link, useNavigate } from "react-router-dom";
import type { AnalysisJob, CommentAudience, PrDetail, RevisionInfo } from "../api/types";
import { isJobLive } from "../api/types";
import { AnalysisChip } from "./Analysis";
import { AuthorAvatar } from "./AuthorAvatar";
import { CiMark, PrStateIcon, ReviewRequestAge, StackedOnChip } from "./Chips";
import { ReviewersMark, showsReviewers } from "./Reviewers";
import { RevisionMenu } from "./RevisionMenu";
import { diffTotals, formatAddedAt } from "../lib/prList";
import { formatRevisionSummary, revisionSummaryLines } from "../lib/revisionSummary";
import { stackedOnLink } from "../lib/stacked";
import { CopyPathButton } from "./DiffPane";
import { useModalBackground } from "./Modal";
import { OverflowMenu } from "./OverflowMenu";
import {
  IconArchive,
  IconArrowLeft,
  IconBolt,
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
  audience = "github",
  onAudienceChange,
  view = "units",
  onView,
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
  /** who new comments are for; only the agent case is shown */
  audience?: CommentAudience;
  onAudienceChange?: (next: CommentAudience) => void;
  /** which way the PR is being read; omit `onView` to hide the tabs */
  view?: PrViewMode;
  onView?: (view: PrViewMode) => void;
  /** the view-options popover (diff layout, wrapping, threads) */
  viewOptions?: React.ReactNode;
  onShowShortcuts?: () => void;
}) {
  // The tag popover hangs under the chip when there is one, under the ⋯ menu otherwise.
  const tagChipRef = useRef<HTMLButtonElement>(null);
  const tagMenuRef = useRef<HTMLDivElement>(null);
  const [tagOpen, setTagOpen] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const { meta, state } = detail;
  const live = isJobLive(analysisJob);
  // The gear opens settings over this PR view instead of leaving it.
  const background = useModalBackground();
  const navigate = useNavigate();
  const totals = diffTotals(detail.files.files);
  return (
    <header
      className="flex flex-none flex-wrap items-center gap-x-2 gap-y-1.5 border-b px-2 py-2 sm:flex-nowrap sm:gap-3 sm:px-3"
      style={{ borderColor: "var(--border)", background: "var(--bg)" }}
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
      {/* Phone width: back + actions share the first row, and the title
          takes a full-width row of its own under them. */}
      <div className="order-last flex min-w-0 flex-1 basis-full flex-col justify-center gap-0.5 sm:order-none sm:basis-auto">
        {/* The PR's state only when it is not the usual one: a draft, a
            merged or a closed PR reads differently, an open one doesn't. */}
        <span className="flex min-w-0 items-center gap-1.5">
          {meta.prState && meta.prState !== "open" ? <PrStateIcon state={meta.prState} /> : null}
          <a
            href={meta.url}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 truncate text-[13px] font-semibold leading-snug hover:underline"
            style={{ color: "var(--fg)" }}
            data-testid="topbar-title"
            data-tip="Open on GitHub"
          >
            {meta.title ?? `${meta.owner}/${meta.repo}#${meta.number}`}
          </a>
        </span>
        {/* One quiet line, in the order a person says it: who, which PR,
            from where to where, how big. Then only what needs the reader. */}
        <div
          className="flex min-w-0 items-center gap-x-2 overflow-hidden whitespace-nowrap text-2xs leading-4"
          style={{
            color: "var(--fg-faint)",
            maskImage: "linear-gradient(to right, black calc(100% - 2rem), transparent)",
            WebkitMaskImage: "linear-gradient(to right, black calc(100% - 2rem), transparent)",
          }}
          data-testid="topbar-meta"
        >
          {meta.author ? (
            <span className="flex flex-none items-center gap-1" data-tip={`Opened by ${meta.author}`}>
              <AuthorAvatar author={meta.author} url={meta.authorAvatarUrl} size={14} />
              <span style={{ color: "var(--fg-muted)" }}>{meta.author}</span>
            </span>
          ) : null}
          <span className="flex flex-none items-center gap-1 font-mono">
            {meta.repo}#{meta.number}
            <CopyPathButton path={String(meta.number)} what="PR number" />
          </span>
          <span className="flex-none tabular-nums" data-tip={`${totals.files} files changed`}>
            <span style={{ color: "var(--ok)" }}>+{totals.additions}</span>{" "}
            <span style={{ color: "var(--risk)" }}>−{totals.deletions}</span>
          </span>
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
          {/* Last: the longest and least needed, so the fade takes it first. */}
          {meta.headRef ? (
            <span
              className="hidden min-w-[8rem] items-center gap-1 md:flex"
              data-tip={meta.baseRef ? `${meta.headRef} → ${meta.baseRef}` : meta.headRef}
              data-testid="topbar-branch"
            >
              <span className="truncate font-mono">
                {meta.baseRef ? `${meta.baseRef} ← ` : ""}
                {meta.headRef}
              </span>
              <CopyPathButton path={meta.headRef} what="branch name" />
            </span>
          ) : null}
        </div>
      </div>

      {onView ? <ViewTabs view={view} onView={onView} /> : null}

      <div className="ml-auto flex flex-none items-center gap-1.5 sm:ml-0 sm:gap-2">
        {stale ? (
          // Quiet until GitHub moved: then it is the one thing worth a press.
          <button
            type="button"
            className="btn"
            data-testid="topbar-refresh"
            data-stale="1"
            data-tip={refreshing ? "Refreshing…" : (staleTooltip ?? "Refresh from GitHub")}
            onClick={onRefresh}
            disabled={refreshing}
            style={{ color: "var(--accent)", borderColor: "var(--accent)" }}
          >
            <IconRefresh width={12} height={12} className={refreshing ? "animate-spin" : undefined} />
            <span className="hidden md:inline">new commits</span>
          </button>
        ) : null}
        {viewOptions}
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
        <div ref={tagMenuRef} className="contents">
        <OverflowMenu
          items={[
            { label: meta.tag ? "change tag…" : "tag…", testId: "header-tag-menu", icon: <IconTag width={12} height={12} />, onClick: () => setTagOpen(true) },
            {
              label: refreshing ? "refreshing…" : "refresh from GitHub",
              icon: <IconRefresh width={12} height={12} />,
              testId: "menu-refresh",
              disabled: refreshing,
              hint: staleTooltip ?? "Fetch the PR's latest commits and comments.",
              onClick: onRefresh,
            },
            {
              label: syncing ? "syncing…" : "sync to GitHub",
              icon: <IconUpload width={12} height={12} />,
              testId: "menu-sync",
              disabled: syncing,
              hint: "Push viewed files and comments to GitHub.",
              onClick: onSync,
            },
            ...(live
              ? [
                  {
                    label: analysisCancelling ? "cancelling analysis…" : "cancel analysis",
                    icon: <IconClose width={12} height={12} />,
                    testId: "menu-cancel-analysis",
                    dividerBefore: true,
                    disabled: analysisCancelling,
                    onClick: onCancelAnalysis,
                  },
                ]
              : [
                  {
                    label: analysisStarting ? "starting analysis…" : "analyze again",
                    icon: <IconBolt width={12} height={12} />,
                    testId: "menu-analyze-again",
                    dividerBefore: true,
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
                      ? "Drops every unit, the summary and the map, then analyzes this revision again from nothing."
                      : "No analysis yet — analyze first.",
                    onClick: onAnalyzeFresh,
                  },
                ]),
            {
              label: exporting ? "exporting…" : "export analysis",
              icon: <IconDownload width={12} height={12} />,
              testId: "menu-export-analysis",
              disabled: exporting || !hasAnalysis,
              hint: hasAnalysis
                ? "Download the current analysis to share with a teammate tracking this PR."
                : "No analysis yet — analyze first.",
              onClick: onExportAnalysis,
            },
            {
              label: "import analysis…",
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
            ...(onSetArchived
              ? [
                  {
                    label: meta.archived ? "unarchive" : "archive",
                    dividerBefore: true,
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
          data-tip-key="r"
          onClick={onFinishReview}
        >
          <IconCheck width={12} height={12} />
          {/* One flex item, so the button's gap never lands between the words. */}
          <span>
            finish<span className="hidden lg:inline"> review</span>
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
    </header>
  );
}

export type PrViewMode = "overview" | "units" | "files";

const VIEW_TABS: { id: PrViewMode; label: string; key: string; tip: string }[] = [
  { id: "overview", label: "Overview", key: "s", tip: "Summary, shape and what to read closely" },
  { id: "units", label: "Guide", key: "g", tip: "The PR unit by unit" },
  { id: "files", label: "Files", key: "f", tip: "The PR file by file" },
];

/** Overview · Guide · Files: the three ways to read the PR. */
function ViewTabs({ view, onView }: { view: PrViewMode; onView: (v: PrViewMode) => void }) {
  return (
    <nav
      className="flex flex-none items-center gap-0.5 rounded-md p-0.5"
      style={{ background: "var(--bg-inset)" }}
      aria-label="View"
      data-testid="view-tabs"
    >
      {VIEW_TABS.map((t) => {
        const on = t.id === view;
        return (
          <button
            key={t.id}
            type="button"
            data-testid={`view-${t.id}`}
            aria-pressed={on}
            data-tip={t.tip}
            data-tip-key={t.key}
            onClick={() => onView(t.id)}
            className="rounded px-2 py-1 text-xs transition-colors lg:px-2.5"
            style={
              on
                ? { background: "var(--bg-raised)", color: "var(--fg)", boxShadow: "0 0 0 1px var(--border)" }
                : { color: "var(--fg-muted)" }
            }
          >
            {t.label}
          </button>
        );
      })}
    </nav>
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
