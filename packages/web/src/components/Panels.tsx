import type { ReactNode } from "react";
import type {
  AnalysisImportReport,
  MigrationReport,
  ShareAnalysisResult,
  Staleness,
  SyncResult,
} from "../api/types";
import { stalenessReasonText } from "../lib/staleness";
import { IconClose, IconRefresh } from "./icons";

export function DismissiblePanel({
  tone = "neutral",
  title,
  onDismiss,
  children,
}: {
  tone?: "neutral" | "warn" | "error";
  title: string;
  onDismiss: () => void;
  children?: ReactNode;
}) {
  const accent =
    tone === "error" ? "var(--risk)" : tone === "warn" ? "var(--warn)" : "var(--accent)";
  const bg =
    tone === "error" ? "var(--risk-soft)" : tone === "warn" ? "var(--warn-soft)" : "var(--accent-soft)";
  return (
    <div
      className="flex-none border-b px-3 py-2 text-xs"
      style={{ background: bg, borderColor: "var(--border)" }}
    >
      <div className="flex items-center gap-2">
        <span className="font-semibold" style={{ color: accent }}>
          {title}
        </span>
        <button
          type="button"
          className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-px text-2xs"
          style={{ color: "var(--fg-muted)" }}
          onClick={onDismiss}
        >
          dismiss <IconClose width={10} height={10} />
        </button>
      </div>
      {children ? <div className="mt-1.5">{children}</div> : null}
    </div>
  );
}

/**
 * The loud half of the staleness signal: a slim bar under the top bar, with
 * the refresh it is asking for inline. Dismissing it is remembered per
 * upstream revision by the caller — the dot on the refresh button is what
 * stays behind.
 */
export function StalenessHint({
  result,
  refreshing,
  onRefresh,
  onDismiss,
}: {
  result: Staleness;
  refreshing: boolean;
  onRefresh: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      data-testid="staleness-hint"
      className="flex flex-none items-center gap-2 border-b px-3 py-1.5 text-xs"
      style={{ background: "var(--accent-soft)", borderColor: "var(--border)" }}
    >
      <span style={{ color: "var(--accent)" }}>
        This PR changed upstream — refresh to fetch the latest
      </span>
      {result.reasons.length > 0 ? (
        <span className="text-2xs" style={{ color: "var(--fg-muted)" }}>
          {stalenessReasonText(result.reasons)}
        </span>
      ) : null}
      <button
        type="button"
        className="btn ml-auto"
        data-testid="staleness-refresh"
        disabled={refreshing}
        onClick={onRefresh}
      >
        <IconRefresh width={11} height={11} />
        {refreshing ? "refreshing…" : "refresh"}
      </button>
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded px-1.5 py-px text-2xs"
        data-testid="staleness-dismiss"
        style={{ color: "var(--fg-muted)" }}
        onClick={onDismiss}
      >
        dismiss <IconClose width={10} height={10} />
      </button>
    </div>
  );
}

const COUNT_ORDER: { key: keyof NonNullable<MigrationReport["counts"]>; label: string }[] = [
  { key: "carried", label: "carried" },
  { key: "fuzzy", label: "fuzzy" },
  { key: "renamed", label: "renamed" },
  { key: "archived", label: "archived" },
  { key: "new", label: "new" },
];

export function MigrationReportPanel({
  report,
  onDismiss,
}: {
  report: MigrationReport;
  onDismiss: () => void;
}) {
  const counts = report.counts ?? {
    carried: report.carried?.length,
    fuzzy: report.fuzzy?.length,
    renamed: report.renamed?.length,
    archived: report.archived?.length,
    new: report.new?.length,
  };
  const details: { label: string; items: NonNullable<MigrationReport["fuzzy"]> }[] = [
    { label: "fuzzy", items: report.fuzzy ?? [] },
    { label: "renamed", items: report.renamed ?? [] },
    { label: "archived", items: report.archived ?? [] },
    { label: "new", items: report.new ?? [] },
  ].filter((d) => d.items.length > 0);

  return (
    <DismissiblePanel
      tone="warn"
      title={`migration report${report.revision !== undefined ? ` · revision ${report.revision}` : ""}${
        report.baseOnly ? " · base moved only" : ""
      }`}
      onDismiss={onDismiss}
    >
      <div className="flex flex-wrap items-center gap-3">
        {COUNT_ORDER.map(({ key, label }) => (
          <span key={key} className="tabular-nums" style={{ color: "var(--fg-muted)" }}>
            <span style={{ color: "var(--fg)" }}>{counts?.[key] ?? 0}</span> {label}
          </span>
        ))}
        {report.noChange ? <span style={{ color: "var(--fg-muted)" }}>· already up to date</span> : null}
      </div>
      {details.length ? (
        <ul className="mt-1.5 space-y-0.5 font-mono text-2xs" style={{ color: "var(--fg-muted)" }}>
          {details.flatMap((d) =>
            d.items.slice(0, 8).map((item) => (
              <li key={`${d.label}:${item.hunkId}`}>
                <span style={{ color: "var(--warn)" }}>{d.label}</span> {item.file ?? ""}{" "}
                {item.hunkId?.slice(0, 8)}
                {item.note ? ` — ${item.note}` : ""}
              </li>
            )),
          )}
        </ul>
      ) : null}
    </DismissiblePanel>
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
    <DismissiblePanel title="analysis imported" onDismiss={onDismiss}>
      <div style={{ color: "var(--fg-muted)" }}>
        A shared analysis{author ? ` by ${author}` : ""} was found on the PR (posted{" "}
        {new Date(postedAt).toLocaleString()}) and imported — no analysis run was needed.
      </div>
    </DismissiblePanel>
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
    <DismissiblePanel title="sync" onDismiss={onDismiss}>
      <div style={{ color: "var(--fg-muted)" }}>
        {result.filesSynced ?? 0} files marked viewed on GitHub · {result.commentsPosted ?? 0}{" "}
        comments posted as a pending review
        {result.reviewUrl ? (
          <>
            {" · "}
            <a
              href={result.reviewUrl}
              target="_blank"
              rel="noreferrer"
              className="underline"
              style={{ color: "var(--accent)" }}
            >
              open review
            </a>
          </>
        ) : null}
        {result.message ? <div className="mt-1">{result.message}</div> : null}
        {result.drift?.length ? (
          <div className="mt-1" style={{ color: "var(--warn)" }}>
            drift detected on: {result.drift.join(", ")}
          </div>
        ) : null}
      </div>
    </DismissiblePanel>
  );
}

/**
 * "import analysis…" is a two-step act (it replaces the current analysis):
 * this panel is the confirm step, shown after a file was picked and parsed
 * but before anything is posted. `onDismiss`/`onCancel` are the same "back
 * out" action.
 */
export function AnalysisImportConfirmPanel({
  filename,
  importing,
  onConfirm,
  onCancel,
}: {
  filename: string;
  importing: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <DismissiblePanel tone="warn" title="replace current analysis?" onDismiss={onCancel}>
      <div className="flex flex-wrap items-center gap-2">
        <span style={{ color: "var(--fg-muted)" }}>
          Importing <span style={{ color: "var(--fg)" }}>{filename}</span> replaces the current
          analysis (units, kinds, findings). What you've already viewed is untouched.
        </span>
        <button
          type="button"
          className="btn btn-primary"
          data-testid="analysis-import-confirm"
          disabled={importing}
          onClick={onConfirm}
        >
          {importing ? "importing…" : "import"}
        </button>
      </div>
    </DismissiblePanel>
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
    <DismissiblePanel title="analysis imported" onDismiss={onDismiss}>
      <div style={{ color: "var(--fg-muted)" }}>
        {source ? (
          <div className="mb-1">
            shared{source.author ? ` by ${source.author}` : ""} on{" "}
            {new Date(source.postedAt).toLocaleDateString()}
          </div>
        ) : null}
        <span style={{ color: "var(--fg)" }}>{report.unitsImported}</span> unit
        {report.unitsImported === 1 ? "" : "s"} imported
        {report.unitsDropped > 0
          ? `, ${report.unitsDropped} dropped (no longer in this revision)`
          : ""}
        {" · "}
        <span style={{ color: "var(--fg)" }}>{report.hunksMatched}</span> hunk
        {report.hunksMatched === 1 ? "" : "s"} matched
        {report.hunksUnassigned > 0 ? `, ${report.hunksUnassigned} left unassigned` : ""}
        {!report.sameRevision ? (
          <div className="mt-1" style={{ color: "var(--warn)" }}>
            imported onto a different revision than it was exported from — unassigned hunks may
            need classifying.
          </div>
        ) : null}
      </div>
    </DismissiblePanel>
  );
}

/**
 * "share analysis to PR" is a public write (a comment lands on GitHub) — this
 * is the confirm step, shown after the overflow menu item is picked and
 * before anything is posted.
 */
export function ShareAnalysisConfirmPanel({
  sharing,
  onConfirm,
  onCancel,
}: {
  sharing: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <DismissiblePanel tone="warn" title="share analysis to this PR?" onDismiss={onCancel}>
      <div className="flex flex-wrap items-center gap-2">
        <span style={{ color: "var(--fg-muted)" }}>
          Posts the current analysis as a comment on this PR's conversation tab, publicly on
          GitHub. A teammate tracking the same PR can import it from there instead of paying for
          their own analysis run.
        </span>
        <button
          type="button"
          className="btn btn-primary"
          data-testid="share-analysis-confirm"
          disabled={sharing}
          onClick={onConfirm}
        >
          {sharing ? "sharing…" : "share"}
        </button>
      </div>
    </DismissiblePanel>
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
    <DismissiblePanel title={result.updated ? "analysis comment updated" : "analysis shared"} onDismiss={onDismiss}>
      <div style={{ color: "var(--fg-muted)" }}>
        {result.updated
          ? "Updated the existing analysis comment on this PR."
          : "Posted a new analysis comment on this PR."}
        {" · "}
        <a
          href={result.commentUrl}
          target="_blank"
          rel="noreferrer"
          className="underline"
          style={{ color: "var(--accent)" }}
        >
          view comment
        </a>
      </div>
    </DismissiblePanel>
  );
}

/**
 * "import analysis from PR" is two steps too — it replaces the current
 * analysis, same as the file import, just sourced from the PR's own
 * conversation tab instead of a picked file.
 */
export function ImportFromPrConfirmPanel({
  importing,
  onConfirm,
  onCancel,
}: {
  importing: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <DismissiblePanel tone="warn" title="replace current analysis?" onDismiss={onCancel}>
      <div className="flex flex-wrap items-center gap-2">
        <span style={{ color: "var(--fg-muted)" }}>
          Imports the analysis shared as a comment on this PR, replacing the current one (units,
          kinds, findings). What you've already viewed is untouched.
        </span>
        <button
          type="button"
          className="btn btn-primary"
          data-testid="import-from-pr-confirm"
          disabled={importing}
          onClick={onConfirm}
        >
          {importing ? "importing…" : "import"}
        </button>
      </div>
    </DismissiblePanel>
  );
}

/**
 * The PR-view banner for an auto-detected shared analysis: shown only when
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
    <div
      data-testid="shared-analysis-banner"
      className="flex flex-none items-center gap-2 border-b px-3 py-1.5 text-xs"
      style={{ background: "var(--accent-soft)", borderColor: "var(--border)" }}
    >
      <span style={{ color: "var(--accent)" }}>
        Shared analysis{author ? ` by ${author}` : ""} (
        {sameCommit ? "same commit" : "older commit"})
      </span>
      <button
        type="button"
        className="btn ml-auto"
        data-testid="shared-analysis-import"
        disabled={importing}
        onClick={onImport}
      >
        {importing ? "importing…" : "import"}
      </button>
      <button
        type="button"
        className="btn"
        data-testid="shared-analysis-analyze-fresh"
        onClick={onAnalyzeFresh}
      >
        analyze fresh
      </button>
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded px-1.5 py-px text-2xs"
        data-testid="shared-analysis-dismiss"
        style={{ color: "var(--fg-muted)" }}
        onClick={onDismiss}
      >
        dismiss <IconClose width={10} height={10} />
      </button>
    </div>
  );
}
