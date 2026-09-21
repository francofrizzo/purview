import type { PrDetail, ReviewUnit } from "../api/types";
import { attentionColor, attentionSoftBg } from "./Chips";
import { unitProgress } from "../lib/diffModel";
import { unitDisplayOrder } from "../lib/unitOrder";
import { UNPLACED_ID, unplacedHunkIds } from "../lib/unplaced";
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
  // Same rule as the full sidebar's group: only alongside real units.
  const unplaced = ordered.length ? unplacedHunkIds(detail) : [];
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
            // A unit mid-review fills in as a pie, in the same hue as the
            // number. Nothing to show it for: an empty unit (its flat tint is
            // not a completion state — see `done` above) or a finished one
            // (recedes to flat + faint instead, its job is done).
            const showPie = p.total > 0 && !done;
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
                  background: showPie
                    ? // The whole pill is the pie: the viewed fraction sweeps
                      // clockwise in a slightly stronger tint of the same hue
                      // over the unit's usual soft tint, so progress reads as
                      // the square filling in rather than a gauge sitting on it.
                      `conic-gradient(color-mix(in srgb, ${fill} 30%, transparent) ${pct * 360}deg, ${attentionSoftBg(u.attention)} 0)`
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
          {unplaced.length ? (
            <UnplacedCell
              detail={detail}
              hunkIds={unplaced}
              selected={selectedUnitId === UNPLACED_ID}
              match={Boolean(matchCounts?.get(UNPLACED_ID))}
              onSelect={() => onSelect(UNPLACED_ID)}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The "Not in any unit" pseudo-unit on the rail: a "?" instead of a number
 * (it is not part of the reading order), neutral instead of an attention hue,
 * and a dashed outline so it never reads as unit N+1. Kept on the rail rather
 * than skipped because in drawer mode the rail is the resting state — without
 * it these hunks would only be reachable by opening the drawer.
 */
function UnplacedCell({
  detail,
  hunkIds,
  selected,
  match,
  onSelect,
}: {
  detail: PrDetail;
  hunkIds: string[];
  selected: boolean;
  match: boolean;
  onSelect: () => void;
}) {
  const viewed = hunkIds.filter((id) => detail.state.hunks[id]?.viewed).length;
  const label = `Not in any unit — ${viewed}/${hunkIds.length} hunks`;
  return (
    <button
      type="button"
      onClick={onSelect}
      title={label}
      aria-label={label}
      data-testid="rail-unplaced"
      className="sidebar-rail-item relative mt-1 flex flex-none items-center justify-center rounded font-mono text-2xs"
      style={{
        background: "transparent",
        color: viewed === hunkIds.length ? "var(--fg-faint)" : "var(--fg-muted)",
        border: "1px dashed var(--border-strong)",
        boxShadow: selected ? "0 0 0 2px var(--accent)" : "none",
      }}
    >
      ?
      {match ? (
        <span
          className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full"
          style={{ background: "var(--accent)" }}
        />
      ) : null}
    </button>
  );
}
