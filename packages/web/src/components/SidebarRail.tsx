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
            // A unit mid-review gets a circular progress ring instead of a
            // flat tint — a hunk-count-shaped clock face, in the same hue as
            // the number. Nothing to show it for: an empty unit (no ring, its
            // flat tint is not a completion state — see `done` above) or a
            // finished one (recedes to flat + faint instead, its job is done).
            const showRing = p.total > 0 && !done;
            const pct = p.total > 0 ? p.viewed / p.total : 0;
            const fill = attentionColor(u.attention);
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
                  background: showRing
                    ? // Two layers: a solid disc (the rail's own background
                      // colour, so it reads as a punched-out hole rather than
                      // a second colour) leaving a thin rim, over a conic
                      // gradient clock-facing the viewed fraction. `closest-side`
                      // ties both to the button's own box, so this tracks the
                      // 1.75rem/2.25rem size swap under a coarse pointer for free.
                      `radial-gradient(circle closest-side, var(--bg-raised) calc(100% - 3px), transparent calc(100% - 3px)), ` +
                      `conic-gradient(${fill} ${pct * 360}deg, var(--border-strong) 0)`
                    : done
                      ? "transparent"
                      : attentionSoftBg(u.attention),
                  color: done ? "var(--fg-faint)" : fill,
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
