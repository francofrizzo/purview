import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { isGeneratedUnit, type Attention, type PrDetail, type ReviewUnit } from "../api/types";
import { unitProgress } from "../lib/diffModel";
import { useSettings } from "../lib/settings";
import { filterUnits, hiddenHint } from "../lib/unitFilter";
import { workUnits } from "../lib/generated";
import { unitDisplayNumbers, unitDisplayOrder } from "../lib/unitOrder";
import { UNPLACED_ID, unplacedHunkIds } from "../lib/unplaced";
import { attentionColor, ChangedBadge, ViewedBox } from "./Chips";
import { FindingsBadge } from "./Findings";
import { UnitChangelog } from "./UnitChangelog";
import { IconChevron, IconGenerated, RISK_META } from "./icons";
import { LineDelta, unitFiles } from "./UnitBrief";
import { InlineMarkdown } from "./Markdown";

export const UNPLACED_TITLE =
  "Hunks the analysis hasn't placed in a unit yet, usually new commits since the last analysis";

const GROUPS: { attention: Attention; label: string; defaultOpen: boolean }[] = [
  { attention: "must-read", label: "Must read", defaultOpen: true },
  { attention: "skim", label: "Skim", defaultOpen: true },
  { attention: "skip", label: "Skip", defaultOpen: false },
];

export function UnitSidebar({
  detail,
  selectedUnitId,
  onSelect,
  matchCounts,
  onlyUnitIds,
  changedUnits,
  renderBrief,
  onToggleUnitViewed,
  markingUnitId,
}: {
  detail: PrDetail;
  selectedUnitId: string | null;
  onSelect: (unitId: string) => void;
  /** search hits per unit; units with none render exactly as they always do */
  matchCounts?: Map<string, number>;
  /** list only these units (the "since your review" filter); numbers stay as without it */
  onlyUnitIds?: ReadonlySet<string>;
  /** units the highlighted revisions changed, with the tip saying which */
  changedUnits?: { ids: ReadonlySet<string>; tip: string };
  /** the selected unit's guide text, drawn under its row */
  renderBrief?: (unit: ReviewUnit) => ReactNode;
  /** the row's box: every hunk of the unit viewed, or none */
  onToggleUnitViewed?: (unit: ReviewUnit, viewed: boolean) => void;
  /** the unit whose whole-unit mark is being saved */
  markingUnitId?: string | null;
}) {
  const [open, setOpen] = useState<Record<Attention, boolean>>({
    "must-read": true,
    skim: true,
    skip: false,
  });
  const { settings } = useSettings();
  const hide = settings.hideReviewedUnits;

  // Selecting a unit opens its group: a selection hidden inside a collapsed
  // bucket loses the reader's place. Only on a new selection, so the group
  // can still be collapsed by hand afterwards.
  const selectedAttention = detail.state.units.find((u) => u.id === selectedUnitId)?.attention;
  useEffect(() => {
    if (selectedAttention) setOpen((s) => (s[selectedAttention] ? s : { ...s, [selectedAttention]: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUnitId]);

  // Reading order: by attention bucket, `order` within it, the generated unit last.
  const units = unitDisplayOrder(detail.state.units);
  // The generated unit is built before any analysis runs, so it alone does not
  // mean the PR has review units.
  const analyzed = workUnits(units).length > 0;
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
  const unplaced = analyzed ? unplacedHunkIds(detail) : [];

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
      {!analyzed ? (
        <p className="px-4 pb-2 pt-3 text-xs leading-5" style={{ color: "var(--fg-faint)" }}>
          No review units yet — the banner above tracks the analysis of this revision.
        </p>
      ) : null}
      {hide && totalHidden > 0 ? (
        <p className="px-3 pb-1 text-2xs tabular-nums" style={{ color: "var(--fg-faint)" }} data-testid="hidden-total">
          {totalHidden} read {totalHidden === 1 ? "unit" : "units"} hidden
        </p>
      ) : null}
      {GROUPS.map((g) => {
        const all = units.filter(
          (u) => u.attention === g.attention && (!onlyUnitIds || onlyUnitIds.has(u.id)),
        );
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
              className="flex w-full items-center gap-1.5 px-3 pb-1 pt-2.5 text-2xs font-medium uppercase tracking-wider transition-colors hover:text-[var(--fg-muted)]"
              style={{ color: "var(--fg-faint)" }}
              data-testid={`group-${g.attention}`}
            >
              <span
                className="inline-block h-1.5 w-1.5 flex-none rounded-full"
                style={{ background: attentionColor(g.attention) }}
              />
              {g.label}
              {hidden > 0 ? (
                <span data-testid={`hidden-${g.attention}`} className="normal-case tracking-normal">
                  {hiddenHint(hidden)}
                </span>
              ) : null}
              <span className="ml-auto tabular-nums tracking-normal">
                {groupViewed.viewed}/{groupViewed.total}
              </span>
              <IconChevron open={isOpen} width={9} height={9} />
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
                    matches={matchCounts?.get(u.id)}
                    changedTip={changedUnits?.ids.has(u.id) ? changedUnits.tip : undefined}
                    brief={u.id === selectedUnitId && renderBrief ? renderBrief(u) : null}
                    onToggleViewed={onToggleUnitViewed ? (viewed) => onToggleUnitViewed(u, viewed) : undefined}
                    marking={markingUnitId === u.id}
                  />
                ))}
              </ul>
            ) : null}
          </section>
        );
      })}
      {unplaced.length && (!onlyUnitIds || onlyUnitIds.has(UNPLACED_ID)) ? (
        <UnplacedGroup
          detail={detail}
          hunkIds={unplaced}
          selected={selectedUnitId === UNPLACED_ID}
          onSelect={() => onSelect(UNPLACED_ID)}
          matches={matchCounts?.get(UNPLACED_ID)}
        />
      ) : null}
      {removed.length && !onlyUnitIds ? <RemovedGroup units={removed} /> : null}
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
        data-tip={UNPLACED_TITLE}
        aria-current={selected ? "true" : undefined}
        className="mx-1.5 flex w-[calc(100%-0.75rem)] items-center gap-1.5 rounded-md px-1.5 pb-1 pt-2.5 text-2xs font-medium uppercase tracking-wider transition-colors hover:text-[var(--fg-muted)]"
        style={{
          color: selected ? "var(--fg)" : "var(--fg-faint)",
          background: selected ? "var(--bg-inset)" : "transparent",
        }}
      >
        <span
          className="inline-block h-1.5 w-1.5 flex-none rounded-full border"
          style={{ borderColor: "var(--fg-faint)" }}
        />
        Not in any unit
        <span className="normal-case tracking-normal">({hunkIds.length})</span>
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
        className="flex w-full items-center gap-1.5 px-3 pb-1 pt-2.5 text-2xs font-medium uppercase tracking-wider transition-colors hover:text-[var(--fg-muted)]"
        style={{ color: "var(--fg-faint)" }}
      >
        <span className="inline-block h-1.5 w-1.5 flex-none rounded-full" style={{ background: "var(--border-strong)" }} />
        Removed
        <span className="normal-case tracking-normal">({units.length})</span>
        <span className="ml-auto">
          <IconChevron open={isOpen} width={9} height={9} />
        </span>
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
        data-tip={removedTitle(unit.removedAtRevision)}
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

const UnitRow = memo(function UnitRow({
  detail,
  unit,
  number,
  selected,
  onSelect,
  matches,
  changedTip,
  brief,
  onToggleViewed,
  marking = false,
}: {
  detail: PrDetail;
  unit: ReviewUnit;
  number: number;
  selected: boolean;
  onSelect: () => void;
  matches?: number;
  /** set when the highlighted revisions touched this unit: the badge's tip */
  changedTip?: string;
  brief?: ReactNode;
  /** mark every hunk of the unit viewed (true) or not (false) */
  onToggleViewed?: (viewed: boolean) => void;
  marking?: boolean;
}) {
  const p = unitProgress(detail, unit);
  // Purview's own unit: re-kinding or re-prioritizing it means nothing (it is
  // rebuilt every revision) and the analysis never read it to be asked about.
  const generated = isGeneratedUnit(unit);
  const done = p.total > 0 && p.viewed === p.total;
  const warnings = (unit.findings ?? []).filter((f) => f.severity === "warning").length;
  const files = unitFiles(detail, unit);
  const delta = files.reduce((acc, f) => ({ a: acc.a + f.added, r: acc.r + f.removed }), { a: 0, r: 0 });
  // Kind and risk surfaces are classification detail: on the number, on hover.
  const facts = [
    KIND_WORD[unit.kind],
    ...unit.riskFlags.map((f) => RISK_META[f]?.label ?? f),
  ].join(" · ");
  // Except a risk on a unit the analysis says to skim or skip: that is the one
  // place a risk changes what the reader does, so it is on the row, in words.
  const risks =
    unit.attention !== "must-read" && !generated ? unit.riskFlags.map((f) => RISK_META[f]?.label ?? f) : [];
  const riskWords = risks.length ? (
    <span
      className="flex-none text-2xs"
      style={{ color: "var(--risk)" }}
      data-tip={`${unit.attention === "skip" ? "Skip" : "Skim"}, but a risk surface: ${risks.join(" and ")}`}
      data-testid={`unit-risk-${unit.id}`}
    >
      {risks.join(" · ")}
    </span>
  ) : null;
  const rowRef = useRef<HTMLLIElement>(null);
  // The open unit's brief can run long: keep its title in view when picked
  // from elsewhere (J/K, a link, the map).
  useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <li
      ref={rowRef}
      className="group relative mx-1.5 rounded-md transition-colors"
      data-selected={selected ? "true" : undefined}
      data-testid={selected && brief ? "unit-header" : undefined}
      // The open unit is a tint and nothing else: one cue for "this is inside it".
      style={selected ? { background: "var(--bg-inset)" } : undefined}
    >
      {/* The open unit's header stays pinned while its brief scrolls under
          it: which unit this is, and its box, are always in view. */}
      <div
        className={`flex items-start rounded-md ${selected ? "sticky top-0 z-10" : "hover:bg-[var(--bg-hover)]"}`}
        style={selected ? { background: "var(--bg-inset)" } : undefined}
      >
        <button
          type="button"
          onClick={onSelect}
          aria-current={selected ? "true" : undefined}
          data-testid={`unit-row-${unit.id}`}
          className={`sidebar-row-btn flex min-w-0 flex-1 flex-col gap-1 pl-2 text-left ${selected ? "py-2" : "py-1.5"}`}
          data-tip={selected ? undefined : unit.title}
        >
          <span className="flex w-full items-start gap-2">
            {generated ? (
              <span
                className="flex h-[18px] w-[18px] flex-none items-center justify-center"
                style={{ color: "var(--fg-faint)" }}
                data-tip="Detected by Purview, not by the analysis"
                data-testid="generated-unit-icon"
              >
                <IconGenerated width={12} height={12} />
              </span>
            ) : (
              <span
                className="flex h-[18px] min-w-[18px] flex-none items-center justify-center rounded-[5px] px-1 text-2xs tabular-nums"
                style={{
                  background: selected ? "var(--bg-raised)" : "var(--bg-inset)",
                  color: selected ? "var(--fg)" : "var(--fg-muted)",
                }}
                data-tip={facts}
              >
                {number}
              </span>
            )}
            {/* The rows not being read are one line each, so the list stays
                short beside an open brief; the open one wraps in full. */}
            <span
              className={`min-w-0 flex-1 text-[13px] leading-[18px] ${selected ? "break-words font-medium" : "truncate"}`}
              style={{ color: done && !selected ? "var(--fg-faint)" : "var(--fg)" }}
            >
              <InlineMarkdown text={unit.title} />
            </span>
            {!selected && (riskWords || changedTip || warnings > 0 || matches) ? (
              <span className="flex h-[18px] flex-none items-center gap-1.5">
                {riskWords}
                {changedTip ? (
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ background: "var(--warn)" }}
                    data-tip={changedTip}
                    data-testid={`unit-changed-${unit.id}`}
                  />
                ) : null}
                {warnings > 0 ? <FindingsBadge unit={unit} /> : null}
                {matches ? <MatchBadge count={matches} /> : null}
              </span>
            ) : null}
          </span>
          {/* The open unit: its size, then what asks for the reader. */}
          {selected ? (
          <span
            className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pl-[26px] text-2xs"
            style={{ color: "var(--fg-faint)" }}
          >
            <span>
              {files.length} {files.length === 1 ? "file" : "files"}
            </span>
            <LineDelta added={delta.a} removed={delta.r} />
            {riskWords}
            {changedTip ? <ChangedBadge tip={changedTip} testId={`unit-changed-${unit.id}`} /> : null}
            {warnings > 0 ? <FindingsBadge unit={unit} /> : null}
            {matches ? <MatchBadge count={matches} /> : null}
          </span>
          ) : null}
        </button>
        {/* Its own column: the box to mark the whole unit is on its row,
            wherever the brief scrolls. */}
        <span className={`flex flex-none items-center gap-1.5 pl-1.5 pr-3 ${selected ? "h-[34px]" : "h-[30px]"}`}>
          <span
            className="text-2xs tabular-nums"
            style={{ color: done ? "var(--ok)" : "var(--fg-faint)" }}
            data-tip={`${p.viewed} of ${p.total} hunks viewed`}
            data-testid="hunk-progress"
          >
            {p.viewed}/{p.total}
          </span>
          {onToggleViewed && p.total > 0 ? (
            <ViewedBox
              state={done ? "all" : p.viewed > 0 ? "some" : "none"}
              tip={done ? "Mark the unit as not viewed" : "Mark the whole unit viewed"}
              kbd={selected ? "V" : undefined}
              testId={`unit-viewed-${unit.id}`}
              onToggle={() => onToggleViewed(!done)}
              busy={marking}
            />
          ) : null}
        </span>
      </div>
      {brief}
    </li>
  );
});

const KIND_WORD: Record<ReviewUnit["kind"], string> = {
  "core-logic": "core logic",
  "connective-tissue": "glue",
  wiring: "wiring",
  ripple: "ripple",
  tests: "tests",
  docs: "docs",
  refactor: "refactor",
  data: "data",
};

/** Search-hit count for a sidebar row. Only rendered when there are hits. */
export function MatchBadge({ count }: { count: number }) {
  return (
    <span
      className="chip flex-none tabular-nums"
      data-testid="match-badge"
      data-tip={`${count} search ${count === 1 ? "match" : "matches"}`}
      style={{ background: "var(--search-match)", color: "var(--fg)" }}
    >
      {count}
    </span>
  );
}
