import { useState } from "react";
import type { Attention, ChatRef, PrDetail, ReviewUnit } from "../api/types";
import { unitProgress } from "../lib/diffModel";
import { ChangedBadge, KindChip, Progress, RiskFlags } from "./Chips";
import { IconChevron } from "./icons";
import { ReclassifyPopover } from "./ReclassifyPopover";

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
}: {
  detail: PrDetail;
  selectedUnitId: string | null;
  onSelect: (unitId: string) => void;
  onReclassify: (unitId: string, patch: Partial<ReviewUnit>) => void;
  onQuote?: (ref: ChatRef) => void;
}) {
  const [open, setOpen] = useState<Record<Attention, boolean>>({
    "must-read": true,
    skim: true,
    skip: false,
  });

  const units = [...detail.state.units].sort((a, b) => a.order - b.order);

  // The skill's `order` is global and gappy once units are bucketed by
  // attention (must-read shows 1,2,…,15 and skim then restarts at 6), which
  // reads as broken. Number by rendered position instead — the list is already
  // in reading order — and leave `order` in state untouched.
  const displayNumber = new Map<string, number>();
  let n = 0;
  for (const g of GROUPS) {
    for (const u of units) if (u.attention === g.attention) displayNumber.set(u.id, ++n);
  }

  if (!units.length) {
    return (
      <div className="p-4 text-xs leading-5" style={{ color: "var(--fg-faint)" }}>
        No review units yet — the banner above tracks the analysis of this revision.
      </div>
    );
  }

  return (
    <div className="py-1">
      {GROUPS.map((g) => {
        const groupUnits = units.filter((u) => u.attention === g.attention);
        if (!groupUnits.length) return null;
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
                  />
                ))}
              </ul>
            ) : null}
          </section>
        );
      })}
    </div>
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
}: {
  detail: PrDetail;
  unit: ReviewUnit;
  number: number;
  selected: boolean;
  onSelect: () => void;
  onReclassify: (patch: Partial<ReviewUnit>) => void;
  onQuote?: () => void;
}) {
  const [popover, setPopover] = useState(false);
  const p = unitProgress(detail, unit);

  return (
    <li className="relative">
      <button
        type="button"
        onClick={onSelect}
        className="w-full border-l-2 px-2.5 py-2 text-left transition-colors"
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
            {unit.title}
          </span>
        </div>
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5 pl-5">
          <KindChip kind={unit.kind} />
          <RiskFlags flags={unit.riskFlags} />
          {p.changed > 0 ? <ChangedBadge count={p.changed} /> : null}
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
