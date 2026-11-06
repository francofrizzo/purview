import { useEffect, useRef, useState } from "react";
import type { Attention } from "../api/types";
import type { GroupProgress, ReviewProgress } from "../lib/reviewProgress";
import { UiText } from "./UiText";

const LABEL: Record<Attention, string> = { "must-read": "Must read", skim: "Skim", skip: "Skip" };

/** The attention colors: shades of the accent (see the attn-* theme tokens). */
const INK: Record<Attention, string> = {
  "must-read": "var(--attn-must)",
  skim: "var(--attn-skim)",
  skip: "var(--attn-skip)",
};
const TRACK: Record<Attention, string> = {
  "must-read": "var(--attn-must-soft)",
  skim: "var(--attn-skim-soft)",
  skip: "var(--attn-skip-soft)",
};

const percentOf = (g: GroupProgress) =>
  g.hunksRead === g.hunks ? 100 : Math.min(99, Math.floor((g.read / g.lines) * 100));

/**
 * Where the reading stands, held at the bottom of the sidebar: one bar in three
 * parts, must read, skim and skip, each as wide as its share of the changed
 * lines and filled as far as it is read. Lines read before a revision changed
 * them are hatched, owed again. The total counts must read and skim; skip is
 * shown, never owed. A part opens the first unread unit of its kind.
 */
export function ReviewProgressBar({
  progress,
  onOpenGroup,
}: {
  progress: ReviewProgress;
  onOpenGroup?: (attention: Attention) => void;
}) {
  const shown = progress.groups.filter((g) => g.lines > 0);
  if (!shown.length) return null;
  return (
    <div
      className="flex flex-none flex-col gap-1.5 border-t px-3 pb-2 pt-2"
      style={{ borderColor: "var(--border)" }}
      data-testid="review-progress"
      data-done={progress.done || undefined}
    >
      <div className="flex items-baseline justify-between text-2xs">
        <span className="font-medium" style={{ color: "var(--fg-muted)" }}>
          <UiText>Review progress</UiText>
        </span>
        <span
          className="font-medium tabular-nums"
          style={{ color: progress.done ? "var(--ok)" : "var(--fg-muted)" }}
          data-testid="review-progress-percent"
          data-tip="Changed lines read, must read and skim"
        >
          <UiText>{progress.done ? "all read" : `${progress.percent}%`}</UiText>
        </span>
      </div>
      <div className="flex min-w-0 items-start gap-[3px]">
        {shown.map((g) => (
          <Segment key={g.attention} group={g} onOpen={onOpenGroup} />
        ))}
      </div>
    </div>
  );
}

function Segment({ group: g, onOpen }: { group: GroupProgress; onOpen?: (attention: Attention) => void }) {
  const pct = (n: number) => `${(n / g.lines) * 100}%`;
  const done = g.hunksRead === g.hunks;
  const percent = percentOf(g);
  // The label fits the part: its name and share when there is room, the
  // share alone when narrow, nothing on a sliver.
  const ref = useRef<HTMLButtonElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const label = width >= 84 ? `${LABEL[g.attention]} ${percent}%` : width >= 30 ? `${percent}%` : "";
  const tip =
    `${LABEL[g.attention]}${g.attention === "skip" ? " (doesn't count toward the total)" : ""}: ${g.read} of ${g.lines} lines` +
    (g.units ? `, ${g.unitsDone} of ${g.units} ${g.units === 1 ? "unit" : "units"}` : "") +
    (g.reread ? `, ${g.reread} changed since read` : "");
  return (
    <button
      ref={ref}
      type="button"
      className="group/seg flex min-w-[10px] flex-col items-stretch gap-1 text-left disabled:cursor-default"
      // Each part as wide as its share of the lines; a small one still shows.
      style={{ flexGrow: g.lines, flexBasis: 0 }}
      data-testid={`review-progress-${g.attention}`}
      data-read={g.read}
      data-lines={g.lines}
      data-tip={tip}
      aria-label={tip}
      disabled={done || !onOpen}
      onClick={() => onOpen?.(g.attention)}
    >
      <span
        className="relative block h-1.5 overflow-hidden rounded-full transition-[filter] group-hover/seg:brightness-95 group-disabled/seg:brightness-100"
        style={{ background: TRACK[g.attention] }}
      >
        <span
          className="absolute inset-y-0 left-0 transition-[width] duration-300"
          style={{ width: pct(g.read), background: INK[g.attention] }}
        />
        {g.reread ? (
          <span
            className="absolute inset-y-0"
            style={{
              left: pct(g.read),
              width: pct(g.reread),
              background: `repeating-linear-gradient(135deg, ${INK[g.attention]} 0 2px, transparent 2px 4px)`,
            }}
          />
        ) : null}
      </span>
      {label ? (
        <span
          className="truncate text-2xs leading-none tabular-nums transition-colors group-hover/seg:text-[var(--fg-muted)] group-disabled/seg:text-[var(--fg-faint)]"
          style={{ color: "var(--fg-faint)" }}
          data-testid={`review-progress-${g.attention}-label`}
        >
          <UiText>{label}</UiText>
        </span>
      ) : null}
    </button>
  );
}
