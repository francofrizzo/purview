import { useState } from "react";
import type { UnitChangelogEntry } from "../api/types";
import { changelogView, formatChangelogEntry } from "../lib/changelog";

/**
 * The quiet "Changes" line under a unit's summary: what the newest revision
 * changed in it ("r3 · …"), with the earlier entries behind a small toggle.
 * Styled like the attentionWhy line — an annotation, not chrome.
 *
 * `inline` is for places that are themselves inside a button (a husk's
 * expanded row): no nested toggle, every entry listed, newest first.
 */
export function UnitChangelog({
  changelog,
  inline = false,
  className = "mt-0.5",
}: {
  changelog: UnitChangelogEntry[] | undefined;
  inline?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const view = changelogView(changelog);
  if (!view) return null;
  const rest = inline || open ? view.earlier : [];

  return (
    <div
      className={`${className} max-w-4xl text-2xs leading-4`}
      style={{ color: "var(--fg-faint)" }}
      data-testid="unit-changelog"
    >
      <span>changes: {formatChangelogEntry(view.latest)}</span>
      {!inline && view.earlier.length > 0 ? (
        <>
          {" "}
          <button
            type="button"
            data-testid="changelog-toggle"
            className="underline underline-offset-2"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "hide earlier" : `earlier (${view.earlier.length})`}
          </button>
        </>
      ) : null}
      {rest.length > 0 ? (
        <ul className="mt-0.5 space-y-0.5 pl-3">
          {rest.map((e) => (
            <li key={e.revision}>{formatChangelogEntry(e)}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
