import type { PrDetail, ReviewUnit } from "../api/types";
import { attentionColor, attentionSoftBg } from "./Chips";
import { unitProgress } from "../lib/diffModel";
import { unitDisplayOrder } from "../lib/unitOrder";
import { IconChevron } from "./icons";

/**
 * The sidebar collapsed to a narrow strip: one square per review unit, same
 * order and numbering as the full sidebar (see lib/unitOrder.ts), so the
 * reader never loses their place just from collapsing it. Files have no
 * equivalent here — the rail is a units-only fast path.
 */
export function SidebarRail({
  detail,
  units,
  selectedUnitId,
  matchCounts,
  onSelect,
  onExpand,
  expandLabel,
}: {
  detail: PrDetail;
  units: ReviewUnit[];
  selectedUnitId: string | null;
  /** search hits per unit — shown as a small corner dot, same data as the full sidebar */
  matchCounts?: Map<string, number>;
  onSelect: (unitId: string) => void;
  onExpand: () => void;
  expandLabel: string;
}) {
  const ordered = unitDisplayOrder(units);
  return (
    <div className="sidebar-rail-scroll flex h-full flex-col items-center overflow-y-auto overflow-x-hidden py-1.5">
      <button
        type="button"
        className="flex-none rounded p-1"
        style={{ color: "var(--fg-faint)" }}
        title={expandLabel}
        aria-label={expandLabel}
        onClick={onExpand}
      >
        <IconChevron width={11} height={11} />
      </button>
      {ordered.length ? (
        <div className="mt-1 flex flex-none flex-col items-center gap-1">
          {ordered.map((u, i) => {
            const number = i + 1;
            const p = unitProgress(detail, u);
            const done = p.total > 0 && p.viewed === p.total;
            const selected = u.id === selectedUnitId;
            const label = `${number}. ${u.title} — ${p.viewed}/${p.total} hunks`;
            return (
              <button
                key={u.id}
                type="button"
                onClick={() => onSelect(u.id)}
                title={label}
                aria-label={label}
                className="sidebar-rail-item relative flex flex-none items-center justify-center rounded font-mono text-2xs tabular-nums"
                style={{
                  background: done ? "transparent" : attentionSoftBg(u.attention),
                  color: done ? "var(--fg-faint)" : attentionColor(u.attention),
                  boxShadow: selected ? "0 0 0 2px var(--accent)" : "none",
                }}
              >
                {number}
                {matchCounts?.get(u.id) ? (
                  <span
                    className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full"
                    style={{ background: "var(--accent)" }}
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
