import { useState } from "react";
import type { UnitChangelogEntry } from "../api/types";
import { changelogHeading, changelogView } from "../lib/changelog";
import { IconChevron, IconHistory } from "./icons";
import { InlineMarkdown } from "./Markdown";
import { UiText } from "./UiText";

/**
 * A unit's changelog: one line per revision that changed it, newest first.
 * Collapsed by default to a single, clearly labelled header ("Changelog
 * (3 revisions)") so it never crowds the summary; expanded, each revision gets
 * its own readable row: a small revision badge, then the note in the UI font.
 *
 * `inline` is for places that are themselves inside a button (a husk's
 * expanded row): no nested toggle, the header is a plain label and every
 * entry is listed.
 *
 * With `onSelectRevision`, each row is a toggle: clicking it adds that
 * revision to the highlight in the diff (the lines it changed), clicking an
 * active row takes it out again; several can be on at once. Inline
 * changelogs never offer this.
 */
export function UnitChangelog({
  changelog,
  currentRevision,
  inline = false,
  listOnly = false,
  className = "mt-1.5",
  activeRevisions = [],
  onSelectRevision,
}: {
  changelog: UnitChangelogEntry[] | undefined;
  /** When the newest entry is this revision, the header says so. */
  currentRevision?: number;
  inline?: boolean;
  /** just the entries, open: the header is drawn by whoever holds it (the brief's line of counts) */
  listOnly?: boolean;
  className?: string;
  /** the revisions whose changes the diff is highlighting */
  activeRevisions?: readonly number[];
  /** row click: toggle that revision in or out of the highlight */
  onSelectRevision?: (revision: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const view = changelogView(changelog);
  if (!view) return null;
  const entries = [view.latest, ...view.earlier];
  const expanded = inline || listOnly || open;
  const freshHere = currentRevision !== undefined && view.latest.revision === currentRevision;

  const heading = (
    <>
      <IconHistory width={12} height={12} className="flex-none" />
      <UiText>{changelogHeading(entries.length)}</UiText>
      {freshHere ? (
        <span style={{ color: "var(--accent)" }}><UiText>{`· updated in r${view.latest.revision}`}</UiText></span>
      ) : null}
      {inline ? null : <IconChevron open={open} width={10} height={10} className="flex-none" />}
    </>
  );

  return (
    <div className={`${className} max-w-4xl text-xs`} data-testid="unit-changelog">
      {listOnly ? null : inline ? (
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
        <ol className={listOnly ? "space-y-1" : "mt-1.5 space-y-1 pl-[18px]"}>
          {entries.map((e) => {
            const active = activeRevisions.includes(e.revision);
            const badge = (
              <span
                // Inline at the note's start, so the note's lines wrap under it
                // rather than leaving a column of empty space beside it.
                className="chip mr-1.5 inline-block font-mono"
                style={{
                  background: active ? "var(--warn-soft)" : "var(--bg-inset)",
                  color: active ? "var(--warn)" : "var(--fg-muted)",
                }}
                data-tip={`Revision ${e.revision}`}
              >
                <UiText>{`r${e.revision}`}</UiText>
              </span>
            );
            const note = (
              <span className="[overflow-wrap:anywhere]" style={{ color: "var(--fg)" }}>
                <InlineMarkdown text={e.text} />
              </span>
            );
            if (inline || !onSelectRevision) {
              return (
                <li key={e.revision} className="leading-[18px]">
                  {badge}
                  {note}
                </li>
              );
            }
            return (
              <li key={e.revision}>
                <button
                  type="button"
                  data-testid={`changelog-row-r${e.revision}`}
                  aria-label={`Highlight changes from r${e.revision}`}
                  aria-pressed={active}
                  data-tip={
                    active
                      ? `Showing the lines r${e.revision} changed; click to take it out, esc clears all`
                      : activeRevisions.length > 0
                        ? `Also highlight the lines r${e.revision} changed`
                        : `Highlight the lines r${e.revision} changed`
                  }
                  onClick={() => onSelectRevision(e.revision)}
                  className="changelog-row -mx-1.5 block w-[calc(100%+0.75rem)] rounded px-1.5 text-left leading-[18px]"
                  data-active={active ? "true" : undefined}
                >
                  {badge}
                  {note}
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}
