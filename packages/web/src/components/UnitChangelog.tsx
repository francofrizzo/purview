import { useState } from "react";
import type { UnitChangelogEntry } from "../api/types";
import { changelogHeading, changelogView } from "../lib/changelog";
import { IconChevron, IconHistory } from "./icons";

/**
 * A unit's changelog: one line per revision that changed it, newest first.
 * Collapsed by default to a single, clearly labelled header ("Changelog
 * (3 revisions)") so it never crowds the summary; expanded, each revision gets
 * its own readable row: a small revision badge, then the note in the UI font.
 *
 * `inline` is for places that are themselves inside a button (a husk's
 * expanded row): no nested toggle, the header is a plain label and every
 * entry is listed.
 */
export function UnitChangelog({
  changelog,
  currentRevision,
  inline = false,
  className = "mt-1.5",
}: {
  changelog: UnitChangelogEntry[] | undefined;
  /** When the newest entry is this revision, the header says so. */
  currentRevision?: number;
  inline?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const view = changelogView(changelog);
  if (!view) return null;
  const entries = [view.latest, ...view.earlier];
  const expanded = inline || open;
  const freshHere = currentRevision !== undefined && view.latest.revision === currentRevision;

  const heading = (
    <>
      <IconHistory width={12} height={12} className="flex-none" />
      <span>{changelogHeading(entries.length)}</span>
      {freshHere ? (
        <span style={{ color: "var(--accent)" }}>· updated in r{view.latest.revision}</span>
      ) : null}
      {inline ? null : <IconChevron open={open} width={10} height={10} className="flex-none" />}
    </>
  );

  return (
    <div className={`${className} max-w-4xl text-xs`} data-testid="unit-changelog">
      {inline ? (
        <div className="flex items-center gap-1.5" style={{ color: "var(--fg-muted)" }}>
          {heading}
        </div>
      ) : (
        <button
          type="button"
          data-testid="changelog-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded hover:!text-[var(--fg)]"
          style={{ color: "var(--fg-muted)" }}
        >
          {heading}
        </button>
      )}
      {expanded ? (
        <ol className="mt-1.5 space-y-1 border-l pl-3" style={{ borderColor: "var(--border)" }}>
          {entries.map((e) => (
            <li key={e.revision} className="flex items-baseline gap-2 leading-[18px]">
              <span
                className="chip flex-none font-mono"
                style={{ background: "var(--bg-inset)", color: "var(--fg-muted)" }}
                title={`Revision ${e.revision}`}
              >
                r{e.revision}
              </span>
              <span style={{ color: "var(--fg)" }}>{e.text}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
