import { useState, type ReactNode } from "react";
import type {
  AnalysisImportReport,
  MigrationReport,
  ShareAnalysisResult,
  SyncResult,
} from "../api/types";
import { IconChevron, IconClose } from "./icons";
import { Modal } from "./Modal";
import { NOTICE_FADE_MS, Notice } from "./Notices";
import { revisionFileChanges, revisionNoticeText } from "../lib/revisionNotice";
import { UiText } from "./UiText";

/**
 * A question a menu item asks before it acts (replace the analysis, post a
 * public comment): a small dialog over the page, Cancel or the action.
 */
function ConfirmDialog({
  title,
  action,
  busyAction,
  busy,
  error,
  testId,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  action: string;
  busyAction: string;
  busy: boolean;
  /** the last attempt's refusal; the dialog stays open for another try */
  error?: string | null;
  testId: string;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  return (
    <Modal title={title} maxWidth={480} onClose={() => (busy ? undefined : onCancel())} testId={`${testId}-dialog`}>
      <p className="text-xs leading-5" style={{ color: "var(--fg-muted)" }}>
        {children}
      </p>
      {error ? (
        <p role="alert" className="mt-2 text-xs" style={{ color: "var(--risk)" }}>
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex items-center justify-end gap-2">
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>
          <UiText>Cancel</UiText>
        </button>
        <button type="button" className="btn btn-primary" data-testid={testId} disabled={busy} onClick={onConfirm}>
          <UiText>{busy ? busyAction : action}</UiText>
        </button>
      </div>
    </Modal>
  );
}

/**
 * What a refresh brought, as a toast: a sentence in
 * the reader's words, the analysis's summary of the revision once it has
 * written one, and per file only if they ask. The diff itself already marks
 * what changed; this is the receipt, not the reading.
 */
export function MigrationReportPanel({
  report,
  summary,
  onDismiss,
}: {
  report: MigrationReport;
  /** what the revision changed, in the analysis's words (written after the refresh's patches) */
  summary?: string;
  onDismiss: () => void;
}) {
  const [open, setOpen] = useState(false);
  const files = revisionFileChanges(report);
  return (
    // Held while the file list is open: the reader is in it.
    <Notice title={revisionNoticeText(report)} fadeMs={open ? undefined : NOTICE_FADE_MS * 1.5} onDismiss={onDismiss} testId="revision-notice">
      {summary ? <div data-testid="revision-notice-summary">{summary}</div> : null}
      {files.length ? (
        <button
          type="button"
          className="inline-flex items-center gap-1 text-2xs hover:!text-[var(--fg)]"
          style={{ color: "var(--fg-muted)" }}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <UiText>by file</UiText>
          <IconChevron open={open} width={9} height={9} />
        </button>
      ) : null}
      {open ? (
        <ul className="mt-1 max-h-48 overflow-y-auto pb-1 text-2xs">
          {files.map((f) => (
            <li key={f.file} className="flex items-baseline gap-3 leading-5">
              <span className="min-w-0 truncate font-mono" style={{ color: "var(--fg-muted)" }}>
                {f.file}
              </span>
              <span className="ml-auto flex-none tabular-nums" style={{ color: "var(--fg-faint)" }}>
                <UiText>
                  {[
                    f.added ? `${f.added} new` : "",
                    f.changed ? `${f.changed} changed` : "",
                    f.moved ? `${f.moved} renamed` : "",
                    f.gone ? `${f.gone} gone` : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </UiText>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Notice>
  );
}

/**
 * Shown once, right after adding a PR whose analysis was imported for free
 * from a teammate's shared comment — without this the import is invisible
 * and indistinguishable from a suspiciously instant analysis run.
 */
export function AutoImportedAnalysisPanel({
  author,
  postedAt,
  onDismiss,
}: {
  author?: string;
  postedAt: string;
  onDismiss: () => void;
}) {
  return (
    <Notice title="Analysis imported" fadeMs={NOTICE_FADE_MS} onDismiss={onDismiss} testId="auto-imported-notice">
      <div>
        <UiText>A shared analysis</UiText>
        {author ? <>{" "}<UiText>by</UiText> {author}</> : null}{" "}
        <UiText>{`was found on the PR (posted ${new Date(postedAt).toLocaleString()}) and imported — no analysis run was needed.`}</UiText>
      </div>
    </Notice>
  );
}

export function SyncResultPanel({
  result,
  onDismiss,
}: {
  result: SyncResult;
  onDismiss: () => void;
}) {
  return (
    <Notice title="Synced to GitHub" fadeMs={NOTICE_FADE_MS} onDismiss={onDismiss} testId="sync-notice">
      <div>
        <UiText>{`${result.filesSynced ?? 0} files marked viewed on GitHub · ${result.commentsPosted ?? 0} comments posted as a pending review`}</UiText>
        {result.reviewUrl ? (
          <>
            <UiText>{" · "}</UiText>
            <a
              href={result.reviewUrl}
              target="_blank"
              rel="noreferrer"
              className="underline"
              style={{ color: "var(--accent)" }}
            >
              <UiText>open review</UiText>
            </a>
          </>
        ) : null}
        {result.message ? <div className="mt-1">{result.message}</div> : null}
        {result.drift?.length ? (
          <div className="mt-1" style={{ color: "var(--warn)" }}>
            <UiText>drift detected on:</UiText> {result.drift.join(", ")}
          </div>
        ) : null}
      </div>
    </Notice>
  );
}

/**
 * "import analysis from file…" is a two-step act (it replaces the current analysis):
 * this dialog is the confirm step, shown after a file was picked and parsed
 * but before anything is posted. `onDismiss`/`onCancel` are the same "back
 * out" action.
 */
export function AnalysisImportConfirmPanel({
  filename,
  importing,
  error,
  onConfirm,
  onCancel,
}: {
  filename: string;
  importing: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      error={error}
      title="Replace the current analysis?"
      action="Import"
      busyAction="Importing…"
      busy={importing}
      testId="analysis-import-confirm"
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <UiText>Importing</UiText> <span style={{ color: "var(--fg)" }}>{filename}</span>{" "}
      <UiText>replaces the current analysis (units, kinds, findings). What you've already viewed is untouched.</UiText>
    </ConfirmDialog>
  );
}

export function AnalysisImportResultPanel({
  report,
  source,
  onDismiss,
}: {
  report: AnalysisImportReport;
  /** set when the import came from a PR comment rather than a picked file */
  source?: { author?: string; postedAt: string };
  onDismiss: () => void;
}) {
  return (
    <Notice title="Analysis imported" fadeMs={NOTICE_FADE_MS} onDismiss={onDismiss} testId="import-notice">
      <div>
        {source ? (
          <div className="mb-1">
            <UiText>shared</UiText>
            {source.author ? <>{" "}<UiText>by</UiText> {source.author}</> : null}{" "}
            <UiText>{`on ${new Date(source.postedAt).toLocaleDateString()}`}</UiText>
          </div>
        ) : null}
        <span style={{ color: "var(--fg)" }}>{report.unitsImported}</span>{" "}
        <UiText>
          {`unit${report.unitsImported === 1 ? "" : "s"} imported${
            report.unitsDropped > 0 ? `, ${report.unitsDropped} dropped (no longer in this revision)` : ""
          } · `}
        </UiText>
        <span style={{ color: "var(--fg)" }}>{report.hunksMatched}</span>{" "}
        <UiText>
          {`hunk${report.hunksMatched === 1 ? "" : "s"} matched${
            report.hunksUnassigned > 0 ? `, ${report.hunksUnassigned} left unassigned` : ""
          }`}
        </UiText>
        {!report.sameRevision ? (
          <div className="mt-1" style={{ color: "var(--warn)" }}>
            <UiText>imported onto a different revision than it was exported from — unassigned hunks may need classifying.</UiText>
          </div>
        ) : null}
      </div>
    </Notice>
  );
}

/**
 * "share analysis to PR" is a public write (a comment lands on GitHub) — this
 * is the confirm step, shown after the overflow menu item is picked and
 * before anything is posted.
 */
export function ShareAnalysisConfirmPanel({
  sharing,
  error,
  onConfirm,
  onCancel,
}: {
  sharing: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      error={error}
      title="Share the analysis on this PR?"
      action="Share"
      busyAction="Sharing…"
      busy={sharing}
      testId="share-analysis-confirm"
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <UiText>Posts the current analysis as a comment on this PR's conversation tab, publicly on GitHub. A teammate tracking the same PR can import it from there instead of paying for their own analysis run.</UiText>
    </ConfirmDialog>
  );
}

export function ShareAnalysisResultPanel({
  result,
  onDismiss,
}: {
  result: ShareAnalysisResult;
  onDismiss: () => void;
}) {
  return (
    <Notice title={result.updated ? "Analysis comment updated" : "Analysis shared"} fadeMs={NOTICE_FADE_MS} onDismiss={onDismiss} testId="share-notice">
      <div>
        <UiText>
          {`${result.updated ? "Updated the existing analysis comment on this PR." : "Posted a new analysis comment on this PR."} · `}
        </UiText>
        <a
          href={result.commentUrl}
          target="_blank"
          rel="noreferrer"
          className="underline"
          style={{ color: "var(--accent)" }}
        >
          <UiText>view comment</UiText>
        </a>
      </div>
    </Notice>
  );
}

/**
 * "import analysis from PR" is two steps too — it replaces the current
 * analysis, same as the file import, just sourced from the PR's own
 * conversation tab instead of a picked file.
 */
export function ImportFromPrConfirmPanel({
  importing,
  error,
  onConfirm,
  onCancel,
}: {
  importing: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      error={error}
      title="Replace the current analysis?"
      action="Import"
      busyAction="Importing…"
      busy={importing}
      testId="import-from-pr-confirm"
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <UiText>Imports the analysis shared as a comment on this PR, replacing the current one (units, kinds, findings). What you've already viewed is untouched.</UiText>
    </ConfirmDialog>
  );
}

/**
 * The sidebar card for an auto-detected shared analysis: shown only when
 * there is no local analysis, no live analysis job, and the one-shot probe
 * found something. Session-local — `onDismiss` never persists.
 */
export function SharedAnalysisBanner({
  author,
  sameCommit,
  importing,
  onImport,
  onAnalyzeFresh,
  onDismiss,
}: {
  author?: string;
  sameCommit: boolean;
  importing: boolean;
  onImport: () => void;
  onAnalyzeFresh: () => void;
  onDismiss: () => void;
}) {
  return (
    <section
      data-testid="shared-analysis-banner"
      className="flex-none border-b px-3 py-2.5 text-xs"
      style={{ borderColor: "var(--border)" }}
    >
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 font-semibold leading-5" style={{ color: "var(--accent)" }}>
          <UiText>Shared analysis</UiText>
          {author ? <>{" "}<UiText>by</UiText> {author}</> : null}
        </span>
        <button
          type="button"
          className="flex-none rounded p-1 hover:bg-[var(--bg-hover)]"
          data-testid="shared-analysis-dismiss"
          aria-label="Dismiss"
          data-tip="Dismiss"
          style={{ color: "var(--fg-faint)" }}
          onClick={onDismiss}
        >
          <IconClose width={10} height={10} />
        </button>
      </div>
      <p className="leading-5" style={{ color: "var(--fg-muted)" }}>
        <UiText>{`Posted on this PR for ${sameCommit ? "the same commit" : "an older commit"}. Import it instead of running your own.`}</UiText>
      </p>
      <div className="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          className="btn btn-primary"
          data-testid="shared-analysis-import"
          disabled={importing}
          onClick={onImport}
        >
          <UiText>{importing ? "importing…" : "import"}</UiText>
        </button>
        <button
          type="button"
          className="btn"
          data-testid="shared-analysis-analyze-fresh"
          onClick={onAnalyzeFresh}
        >
          <UiText>analyze fresh</UiText>
        </button>
      </div>
    </section>
  );
}
