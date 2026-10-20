import { Fragment } from "react";
import { isGeneratedUnit, type Attention, type PrDetail, type ReviewUnit } from "../api/types";
import { attentionColor } from "./Chips";
import { unitProgress } from "../lib/diffModel";
import { workUnits } from "../lib/generated";
import { unitDisplayOrder } from "../lib/unitOrder";
import { UNPLACED_ID, unplacedHunkIds } from "../lib/unplaced";
import { IconCheck, IconChevron, IconGenerated } from "./icons";

const ATTENTION_LABEL: Record<Attention, string> = { "must-read": "Must read", skim: "Skim", skip: "Skip" };

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
  // The generated unit alone (built before any analysis) does not count.
  const unplaced = workUnits(ordered).length ? unplacedHunkIds(detail) : [];
  return (
    <div className="sidebar-rail-scroll flex h-full flex-col items-center overflow-y-auto overflow-x-hidden py-1.5">
      <button
        type="button"
        className="flex-none rounded p-1"
        style={{ color: "var(--fg-faint)" }}
        data-tip={expandLabel}
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
            const pct = p.total > 0 ? p.viewed / p.total : 0;
            const selected = u.id === selectedUnitId;
            const label = `${number}. ${u.title} — ${p.viewed}/${p.total} hunks`;
            // Same marks as the full sidebar: a group starts with its
            // attention dot, the number is neutral, progress fills it.
            const groupStart = i === 0 || ordered[i - 1].attention !== u.attention;
            return (
              <Fragment key={u.id}>
                {groupStart ? (
                  <span
                    className={`h-1.5 w-1.5 flex-none rounded-full ${i === 0 ? "" : "mt-1.5"}`}
                    style={{ background: attentionColor(u.attention) }}
                    data-tip={ATTENTION_LABEL[u.attention]}
                  />
                ) : null}
                <button
                  type="button"
                  onClick={() => onSelect(u.id)}
                  data-tip={label}
                  aria-label={label}
                  aria-current={selected ? "true" : undefined}
                  className="sidebar-rail-item relative flex flex-none items-center justify-center rounded-[5px] text-2xs tabular-nums"
                  style={{
                    background:
                      pct > 0 && !done
                        ? `conic-gradient(color-mix(in srgb, var(--accent) 28%, var(--bg-inset)) ${pct * 360}deg, var(--bg-inset) 0)`
                        : "var(--bg-inset)",
                    color: done ? "var(--ok)" : selected ? "var(--fg)" : "var(--fg-muted)",
                    boxShadow: selected ? "0 0 0 1.5px var(--fg-muted)" : "none",
                  }}
                >
                  {/* Same cog as the full sidebar: Purview's unit, not the analysis's. */}
                  {isGeneratedUnit(u) ? (
                    <IconGenerated width={11} height={11} />
                  ) : done ? (
                    <IconCheck width={11} height={11} />
                  ) : (
                    number
                  )}
                  {matchCounts?.get(u.id) ? (
                    <span
                      className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full"
                      style={{ background: "var(--accent)" }}
                    />
                  ) : null}
                </button>
              </Fragment>
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
      data-tip={label}
      aria-label={label}
      data-testid="rail-unplaced"
      className="sidebar-rail-item relative mt-1 flex flex-none items-center justify-center rounded font-mono text-2xs"
      style={{
        background: "transparent",
        color: viewed === hunkIds.length ? "var(--fg-faint)" : "var(--fg-muted)",
        border: "1px dashed var(--border-strong)",
        boxShadow: selected ? "0 0 0 1.5px var(--fg-muted)" : "none",
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
