import { useState } from "react";
import type { Finding, ReviewUnit } from "../api/types";
import { findingsBadge, sortFindings } from "../lib/diffModel";

/**
 * Findings are what the analysis *verified* in the local checkout, as opposed
 * to everything else on a unit, which is how it wants the diff read. They are
 * annotations: nothing here is actionable by the app, nothing is posted, and
 * a unit that verified nothing renders exactly as it always did.
 */

const SEVERITY = {
  warning: { icon: "⚠", color: "var(--warn)", bg: "var(--warn-soft)", label: "warning" },
  note: { icon: "✓", color: "var(--ok)", bg: "var(--ok-soft)", label: "verified" },
} as const;

/** Sidebar badge: `⚠ n` when anything is a warning, else the quieter `✓n`. */
export function FindingsBadge({ unit }: { unit: Pick<ReviewUnit, "findings"> }) {
  const badge = findingsBadge(unit);
  if (!badge) return null;
  const s = SEVERITY[badge.severity];
  const title =
    badge.warnings > 0
      ? `${badge.warnings} warning${badge.warnings === 1 ? "" : "s"}` +
        (badge.notes > 0 ? `, ${badge.notes} verified note${badge.notes === 1 ? "" : "s"}` : "")
      : `${badge.notes} verified note${badge.notes === 1 ? "" : "s"}`;
  return (
    <span
      className="chip flex-none tabular-nums"
      data-testid="findings-badge"
      data-severity={badge.severity}
      title={title}
      // Notes-only is deliberately subtler than a warning: text-only, no fill,
      // so it reads as reassurance rather than as something to act on.
      style={
        badge.severity === "warning"
          ? { color: s.color, background: s.bg }
          : { color: s.color, background: "transparent", opacity: 0.8 }
      }
    >
      {badge.severity === "warning" ? `${s.icon} ${badge.count}` : `${s.icon}${badge.count}`}
    </span>
  );
}

/** How many findings show before the list collapses behind "show all". */
const COLLAPSE_AFTER = 2;

/**
 * The compact list under a unit's summary in the diff pane. Warnings first —
 * if the reader only looks at the first line, it should be the one that might
 * change their review.
 */
export function UnitFindings({ findings }: { findings: Finding[] | undefined }) {
  const [expanded, setExpanded] = useState(false);
  if (!findings?.length) return null;
  const sorted = sortFindings(findings);
  const hidden = sorted.length - COLLAPSE_AFTER;
  const shown = expanded || hidden <= 0 ? sorted : sorted.slice(0, COLLAPSE_AFTER);

  return (
    <ul className="mt-1.5 max-w-4xl space-y-1" data-testid="unit-findings">
      {shown.map((f, i) => {
        const s = SEVERITY[f.severity] ?? SEVERITY.note;
        return (
          <li key={`${f.severity}-${i}-${f.evidence}`} className="flex items-start gap-1.5 text-2xs leading-4">
            <span className="flex-none" style={{ color: s.color }} title={s.label} aria-label={s.label}>
              {s.icon}
            </span>
            <span className="min-w-0">
              <span style={{ color: "var(--fg-muted)" }}>{f.text}</span>{" "}
              <span className="font-mono" style={{ color: "var(--fg-faint)" }}>
                {f.evidence}
              </span>
            </span>
          </li>
        );
      })}
      {hidden > 0 ? (
        <li>
          <button
            type="button"
            data-testid="findings-toggle"
            className="text-2xs underline underline-offset-2"
            style={{ color: "var(--fg-faint)" }}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "show less" : `show all ${sorted.length}`}
          </button>
        </li>
      ) : null}
    </ul>
  );
}
