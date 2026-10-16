import { useState } from "react";
import type { Finding, ReviewUnit } from "../api/types";
import { findingsBadge, sortFindings } from "../lib/diffModel";
import { IconCheck, IconChevron, IconWarning } from "./icons";
import { InlineMarkdown } from "./Markdown";

/**
 * Findings are what the analysis *verified* in the local checkout, as opposed
 * to everything else on a unit, which is how it wants the diff read. They are
 * annotations: nothing here is actionable by the app, nothing is posted, and
 * a unit that verified nothing renders exactly as it always did.
 */

const SEVERITY = {
  warning: { icon: IconWarning, color: "var(--warn)", bg: "var(--warn-soft)", label: "warning" },
  note: { icon: IconCheck, color: "var(--ok)", bg: "var(--ok-soft)", label: "verified" },
} as const;

/** Sidebar badge: warning-triangle + n when anything is a warning, else the quieter check + n. */
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
      data-tip={title}
      // Notes-only is deliberately subtler than a warning: text-only, no fill,
      // so it reads as reassurance rather than as something to act on.
      style={
        badge.severity === "warning"
          ? { color: s.color, background: s.bg }
          : { color: s.color, background: "transparent", opacity: 0.8 }
      }
    >
      <s.icon width={10} height={10} />
      {badge.count}
    </span>
  );
}

/**
 * Units whose checks the reader opened this session. Module state on purpose:
 * the list must not snap shut while the reader works through a unit, and
 * must not stay open on the next unit, where the counts are the point.
 */
const openedChecks = new Set<string>();

/**
 * The checks under a unit's summary in the diff pane, folded to one line of
 * counts by default (warnings in the warn color, so a unit with a problem
 * still announces it) and opened per unit. Warnings first when open — if the
 * reader only looks at the first line, it should be the one that might change
 * their review.
 */
export function UnitFindings({ unitId, findings }: { unitId: string; findings: Finding[] | undefined }) {
  const [, rerender] = useState(0);
  if (!findings?.length) return null;
  const sorted = sortFindings(findings);
  const warnings = sorted.filter((f) => f.severity === "warning").length;
  const notes = sorted.length - warnings;
  const expanded = openedChecks.has(unitId);
  const toggle = () => {
    if (expanded) openedChecks.delete(unitId);
    else openedChecks.add(unitId);
    rerender((n) => n + 1);
  };
  const counts = [
    warnings ? `${warnings} warning${warnings === 1 ? "" : "s"}` : "",
    notes ? `${notes} verified` : "",
  ].filter(Boolean);

  return (
    <div className="mt-1.5 max-w-4xl text-xs" data-testid="unit-findings" data-expanded={expanded}>
      <button
        type="button"
        data-testid="findings-toggle"
        aria-expanded={expanded}
        onClick={toggle}
        className="inline-flex items-center gap-1.5 rounded hover:!text-[var(--fg)]"
        style={{ color: "var(--fg-muted)" }}
      >
        {warnings ? (
          <IconWarning width={12} height={12} className="flex-none" style={{ color: "var(--warn)" }} />
        ) : (
          <IconCheck width={12} height={12} className="flex-none" style={{ color: "var(--ok)" }} />
        )}
        <span>Checks</span>
        <span style={{ color: warnings ? "var(--warn)" : undefined }}>· {counts.join(" · ")}</span>
        <IconChevron open={expanded} width={10} height={10} className="flex-none" />
      </button>
      {expanded ? (
    <ul className="mt-1.5 space-y-1 border-l pl-3" style={{ borderColor: "var(--border)" }}>
      {sorted.map((f, i) => {
        const s = SEVERITY[f.severity] ?? SEVERITY.note;
        return (
          <li key={`${f.severity}-${i}-${f.evidence}`} className="flex items-start gap-1.5 text-2xs leading-4">
            <span
              className="flex-none pt-[3px]"
              style={{ color: s.color }}
              data-tip={s.label}
              aria-label={s.label}
            >
              <s.icon width={10} height={10} />
            </span>
            <span className="min-w-0">
              <span style={{ color: "var(--fg-muted)" }}>
                <InlineMarkdown text={f.text} />
              </span>{" "}
              <span className="font-mono" style={{ color: "var(--fg-faint)" }}>
                {f.evidence}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
      ) : null}
    </div>
  );
}
