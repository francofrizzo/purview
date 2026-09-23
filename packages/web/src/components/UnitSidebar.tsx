import { useState } from "react";
import type { Attention, ChatRef, PrDetail, ReviewUnit } from "../api/types";
import { unitProgress } from "../lib/diffModel";
import { useSettings } from "../lib/settings";
import { filterUnits, hiddenHint } from "../lib/unitFilter";
import { unitDisplayNumbers } from "../lib/unitOrder";
import { UNPLACED_ID, unplacedHunkIds } from "../lib/unplaced";
import { ChangedBadge, KindChip, Progress, RiskFlags } from "./Chips";
import { FindingsBadge } from "./Findings";
import { UnitChangelog } from "./UnitChangelog";
import { IconChevron } from "./icons";
import { ReclassifyPopover } from "./ReclassifyPopover";
import { InlineMarkdown } from "./Markdown";

const HIDE_REVIEWED_TITLE =
  "Drop fully-viewed units out of the list. The unit you are reading stays put, so the diff pane never changes under you.";

export const UNPLACED_TITLE =
  "Hunks the analysis hasn't placed in a unit yet — usually new commits since the last analysis.";

const GROUPS: { attention: Attention; label: string; defaultOpen: boolean }[] = [
  { attention: "must-read", label: "must read", defaultOpen: true },
  { attention: "skim", label: "skim", defaultOpen: true },
  { attention: "skip", label: "skip", defaultOpen: false },
];

export function UnitSidebar({
  detail,
  selectedUnitId,
  onSelect,
  onReclassify,
  onQuote,
  matchCounts,
}: {
  detail: PrDetail;
  selectedUnitId: string | null;
  onSelect: (unitId: string) => void;
  onReclassify: (unitId: string, patch: Partial<ReviewUnit>) => void;
  onQuote?: (ref: ChatRef) => void;
  /** search hits per unit; units with none render exactly as they always do */
  matchCounts?: Map<string, number>;
}) {
  const [open, setOpen] = useState<Record<Attention, boolean>>({
    "must-read": true,
    skim: true,
    skip: false,
  });
  const { settings, update } = useSettings();
  const hide = settings.hideReviewedUnits;

  const units = [...detail.state.units].sort((a, b) => a.order - b.order);
  // Husks live apart from `units` (the client adapter splits them off), so
  // nothing above counts, numbers or hides them.
  const removed = [...(detail.state.removedUnits ?? [])].sort((a, b) => a.order - b.order);

  // "Reviewed" is every hunk viewed. A unit with no hunks at all is not
  // "reviewed", it is empty — hiding those would make them unreachable.
  const isFullyViewed = (u: ReviewUnit) => {
    const p = unitProgress(detail, u);
    return p.total > 0 && p.viewed === p.total;
  };

  // The skill's `order` is global and gappy once units are bucketed by
  // attention (must-read shows 1,2,…,15 and skim then restarts at 6), which
  // reads as broken. Number by rendered position instead — the list is already
  // in reading order — and leave `order` in state untouched. Shared with the
  // collapsed rail (SidebarRail) so the two numberings can never disagree.
  const displayNumber = unitDisplayNumbers(units);

  // Hunks in no live unit. With no units at all that is every hunk, and the
  // analysis banner already tells that story — so the group only appears
  // alongside real units.
  const unplaced = units.length ? unplacedHunkIds(detail) : [];

  const totalHidden = hide
    ? filterUnits(units, { hide, isFullyViewed, selectedId: selectedUnitId }).hidden
    : 0;

  if (!units.length) {
    return (
      <div className="p-4 text-xs leading-5" style={{ color: "var(--fg-faint)" }}>
        No review units yet — the banner above tracks the analysis of this revision.
        {removed.length ? <RemovedGroup units={removed} /> : null}
      </div>
    );
  }

  return (
    <div className="py-1">
      <div
        className="flex items-center gap-1.5 px-2.5 pb-1 pt-0.5 text-2xs"
        style={{ color: "var(--fg-faint)" }}
      >
        <label className="flex cursor-pointer items-center gap-1.5" title={HIDE_REVIEWED_TITLE}>
          <input
            type="checkbox"
            data-testid="hide-reviewed-units"
            checked={hide}
            onChange={(e) => update({ hideReviewedUnits: e.target.checked })}
          />
          hide reviewed
        </label>
        {hide && totalHidden > 0 ? (
          <span className="ml-auto tabular-nums" data-testid="hidden-total">
            {totalHidden} hidden
          </span>
        ) : null}
      </div>
      {GROUPS.map((g) => {
        const all = units.filter((u) => u.attention === g.attention);
        if (!all.length) return null;
        const { shown: groupUnits, hidden } = filterUnits(all, {
          hide,
          isFullyViewed,
          selectedId: selectedUnitId,
        });
        if (!groupUnits.length && hidden === 0) return null;
        const isOpen = open[g.attention];
        const groupViewed = groupUnits.reduce(
          (acc, u) => {
            const p = unitProgress(detail, u);
            acc.viewed += p.viewed;
            acc.total += p.total;
            return acc;
          },
          { viewed: 0, total: 0 },
        );
        return (
          <section key={g.attention} className="mb-1">
            <button
              type="button"
              onClick={() => setOpen((s) => ({ ...s, [g.attention]: !s[g.attention] }))}
              className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-2xs uppercase tracking-wider transition-colors hover:opacity-100"
              style={{
                color:
                  g.attention === "must-read"
                    ? "var(--risk)"
                    : g.attention === "skim"
                      ? "var(--warn)"
                      : "var(--fg-faint)",
              }}
            >
              <IconChevron open={isOpen} width={10} height={10} />
              {g.label}
              <span style={{ color: "var(--fg-faint)" }}>({groupUnits.length})</span>
              {hidden > 0 ? (
                <span data-testid={`hidden-${g.attention}`} style={{ color: "var(--fg-faint)" }}>
                  {hiddenHint(hidden)}
                </span>
              ) : null}
              <span className="ml-auto tabular-nums" style={{ color: "var(--fg-faint)" }}>
                {groupViewed.viewed}/{groupViewed.total}
              </span>
            </button>
            {isOpen ? (
              <ul>
                {groupUnits.map((u) => (
                  <UnitRow
                    key={u.id}
                    detail={detail}
                    unit={u}
                    number={displayNumber.get(u.id) ?? u.order}
                    selected={u.id === selectedUnitId}
                    onSelect={() => onSelect(u.id)}
                    onReclassify={(patch) => onReclassify(u.id, patch)}
                    onQuote={onQuote ? () => onQuote({ kind: "unit", id: u.id }) : undefined}
                    matches={matchCounts?.get(u.id)}
                  />
                ))}
              </ul>
            ) : null}
          </section>
        );
      })}
      {unplaced.length ? (
        <UnplacedGroup
          detail={detail}
          hunkIds={unplaced}
          selected={selectedUnitId === UNPLACED_ID}
          onSelect={() => onSelect(UNPLACED_ID)}
          matches={matchCounts?.get(UNPLACED_ID)}
        />
      ) : null}
      {removed.length ? <RemovedGroup units={removed} /> : null}
    </div>
  );
}

/**
 * The pseudo-unit for hunks no live unit claims. One quiet header, styled
 * like the other group headers, that is itself the selectable row: there is
 * nothing to list under it but "these hunks", and selecting it opens them in
 * the diff pane exactly like a unit.
 */
function UnplacedGroup({
  detail,
  hunkIds,
  selected,
  onSelect,
  matches,
}: {
  detail: PrDetail;
  hunkIds: string[];
  selected: boolean;
  onSelect: () => void;
  matches?: number;
}) {
  const viewed = hunkIds.filter((id) => detail.state.hunks[id]?.viewed).length;
  return (
    <section className="mb-1" data-testid="unplaced-group">
      <button
        type="button"
        onClick={onSelect}
        title={UNPLACED_TITLE}
        aria-current={selected ? "true" : undefined}
        className="flex w-full items-center gap-1.5 border-l-2 px-2.5 py-1.5 text-2xs uppercase tracking-wider transition-colors"
        style={{
          color: selected ? "var(--fg-muted)" : "var(--fg-faint)",
          borderColor: selected ? "var(--accent)" : "transparent",
          background: selected ? "var(--accent-soft)" : "transparent",
        }}
        onMouseEnter={(e) => {
          if (!selected) e.currentTarget.style.background = "var(--bg-hover)";
        }}
        onMouseLeave={(e) => {
          if (!selected) e.currentTarget.style.background = "transparent";
        }}
      >
        {/* Stands in for the chevron so the label lines up with the groups above. */}
        <span className="inline-block w-[10px] text-center normal-case">?</span>
        not in any unit
        <span>({hunkIds.length})</span>
        {matches ? <MatchBadge count={matches} /> : null}
        <span className="ml-auto tabular-nums">
          {viewed}/{hunkIds.length}
        </span>
      </button>
    </section>
  );
}

const removedTitle = (revision: number | undefined) =>
  `Every hunk of this unit left the PR in revision ${revision ?? "?"}. It disappears on the next revision.`;

/**
 * Units whose every hunk left the PR in this revision ("husks"). Shown for
 * one revision so a dropped decision doesn't just silently vanish; they have
 * no hunks, so a row expands its summary instead of opening the diff.
 */
function RemovedGroup({ units }: { units: ReviewUnit[] }) {
  const [isOpen, setIsOpen] = useState(true);
  return (
    <section className="mb-1" data-testid="removed-units">
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-2xs uppercase tracking-wider transition-colors hover:opacity-100"
        style={{ color: "var(--fg-faint)" }}
      >
        <IconChevron open={isOpen} width={10} height={10} />
        removed
        <span>({units.length})</span>
      </button>
      {isOpen ? (
        <ul>
          {units.map((u) => (
            <RemovedRow key={u.id} unit={u} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function RemovedRow({ unit }: { unit: ReviewUnit }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <li>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        title={removedTitle(unit.removedAtRevision)}
        data-testid={`removed-unit-${unit.id}`}
        className="sidebar-row-btn w-full border-l-2 px-2.5 py-2 text-left transition-colors"
        style={{ borderColor: "transparent", background: "transparent" }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--bg-hover)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
        }}
      >
        <div className="flex items-start gap-1.5 pl-5">
          <span
            className="min-w-0 flex-1 break-words pr-3 text-[13px] leading-[18px]"
            style={{ color: "var(--fg-faint)" }}
          >
            <InlineMarkdown text={unit.title} />
          </span>
        </div>
        <div className="mt-1 pl-5 text-2xs" style={{ color: "var(--fg-faint)" }}>
          removed in revision {unit.removedAtRevision ?? "?"}
          {unit.readBeforeRemoval ? " · you had read it" : ""}
        </div>
        {expanded && unit.summary ? (
          <p className="mt-1.5 pl-5 text-xs leading-5" style={{ color: "var(--fg-muted)" }}>
            <InlineMarkdown text={unit.summary} />
          </p>
        ) : null}
        {expanded ? <UnitChangelog changelog={unit.changelog} inline className="mt-1 pl-5" /> : null}
      </button>
    </li>
  );
}

function UnitRow({
  detail,
  unit,
  number,
  selected,
  onSelect,
  onReclassify,
  onQuote,
  matches,
}: {
  detail: PrDetail;
  unit: ReviewUnit;
  number: number;
  selected: boolean;
  onSelect: () => void;
  onReclassify: (patch: Partial<ReviewUnit>) => void;
  onQuote?: () => void;
  matches?: number;
}) {
  const [popover, setPopover] = useState(false);
  const p = unitProgress(detail, unit);

  return (
    <li className="relative">
      <button
        type="button"
        onClick={onSelect}
        className="sidebar-row-btn w-full border-l-2 px-2.5 py-2 text-left transition-colors"
        style={{
          borderColor: selected ? "var(--accent)" : "transparent",
          background: selected ? "var(--accent-soft)" : "transparent",
        }}
        onMouseEnter={(e) => {
          if (!selected) e.currentTarget.style.background = "var(--bg-hover)";
        }}
        onMouseLeave={(e) => {
          if (!selected) e.currentTarget.style.background = "transparent";
        }}
      >
        <div className="flex items-start gap-1.5">
          <span
            className="mt-[3px] flex-none text-xs tabular-nums"
            style={{ color: "var(--fg-faint)" }}
          >
            {number}
          </span>
          <span
            className="min-w-0 flex-1 break-words pr-3 text-[13px] font-medium leading-[18px]"
            title={unit.title}
            style={{ color: p.total > 0 && p.viewed === p.total ? "var(--fg-muted)" : "var(--fg)" }}
          >
            <InlineMarkdown text={unit.title} />
          </span>
        </div>
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5 pl-5">
          <KindChip kind={unit.kind} />
          <RiskFlags flags={unit.riskFlags} compact />
          {p.changed > 0 ? <ChangedBadge count={p.changed} /> : null}
          <FindingsBadge unit={unit} />
          {matches ? <MatchBadge count={matches} /> : null}
          <span className="ml-auto">
            <Progress viewed={p.viewed} total={p.total} />
          </span>
        </div>
      </button>
      <button
        type="button"
        title="Unit actions"
        data-testid={`unit-menu-${unit.id}`}
        onClick={(e) => {
          e.stopPropagation();
          setPopover((v) => !v);
        }}
        className="absolute right-1 top-1.5 rounded px-1 text-xs leading-4 opacity-40 hover:opacity-100"
        style={{ color: "var(--fg-muted)" }}
      >
        ⋯
      </button>
      {popover ? (
        <ReclassifyPopover
          unit={unit}
          onAskClaude={onQuote}
          onClose={() => setPopover(false)}
          onApply={(patch) => {
            onReclassify(patch);
            setPopover(false);
          }}
        />
      ) : null}
    </li>
  );
}

/** Search-hit count for a sidebar row. Only rendered when there are hits. */
export function MatchBadge({ count }: { count: number }) {
  return (
    <span
      className="chip flex-none tabular-nums"
      data-testid="match-badge"
      title={`${count} search ${count === 1 ? "match" : "matches"}`}
      style={{ background: "var(--search-match)", color: "var(--fg)" }}
    >
      {count}
    </span>
  );
}
