import type { ReactNode } from "react";
import type { MigrationReport, SyncResult } from "../api/types";

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
          className="ml-auto rounded px-1.5 py-px text-2xs"
          style={{ color: "var(--fg-muted)" }}
          onClick={onDismiss}
        >
          dismiss ✕
        </button>
      </div>
      {children ? <div className="mt-1.5">{children}</div> : null}
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

export function SummaryPanel({ summary }: { summary?: string }) {
  return (
    <div
      className="flex-none border-b px-4 py-3"
      style={{ borderColor: "var(--border)", background: "var(--bg-raised)" }}
    >
      <div className="mb-1 text-2xs uppercase tracking-wider" style={{ color: "var(--fg-faint)" }}>
        analysis summary
      </div>
      <p className="max-w-4xl text-[13px] leading-[20px]" style={{ color: "var(--fg-muted)" }}>
        {summary?.trim() ||
          "No summary recorded yet. Run the pr-review skill to analyze this pull request."}
      </p>
    </div>
  );
}
