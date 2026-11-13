import { useEffect, useRef, useState } from "react";
import type { Attention, Kind } from "../api/types";
import type { GroupProgress, KindProgress, ReviewProgress } from "../lib/reviewProgress";
import { KIND_STYLE } from "./Chips";
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

type Counts = Omit<GroupProgress, "attention">;

const percentOf = (g: Counts) =>
  g.hunksRead === g.hunks ? 100 : Math.min(99, Math.floor((g.read / g.lines) * 100));

export type ProgressSplit = "attention" | "kind";

/**
 * Where the reading stands, held at the bottom of the sidebar: one bar in
 * parts, each as wide as its share of the changed lines and filled as far as
 * it is read. Split by attention (must read, skim, skip) or by the kind of
 * the unit that claims the lines; the header's switch flips it. Lines read
 * before a revision changed them are hatched, owed again. The total counts
 * must read and skim either way; skip is shown, never owed. A part opens the
 * first unread unit of its attention or kind.
 */
export function ReviewProgressBar({
  progress,
  byKind,
  split = "attention",
  onSplit,
  onOpenGroup,
  onOpenKind,
}: {
  progress: ReviewProgress;
  byKind?: KindProgress[];
  split?: ProgressSplit;
  onSplit?: (split: ProgressSplit) => void;
  onOpenGroup?: (attention: Attention) => void;
  onOpenKind?: (kind: Kind | null) => void;
}) {
  const shown = progress.groups.filter((g) => g.lines > 0);
  if (!shown.length) return null;
  const kindView = split === "kind" && !!byKind?.length;
  return (
    <div
      className="flex flex-none flex-col gap-1.5 border-t px-3 pb-2 pt-2"
      style={{ borderColor: "var(--border)" }}
      data-testid="review-progress"
      data-split={kindView ? "kind" : "attention"}
      data-done={progress.done || undefined}
    >
      <div className="flex items-baseline justify-between gap-2 text-2xs">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="font-medium" style={{ color: "var(--fg-muted)" }}>
            <UiText>Review progress</UiText>
          </span>
          {onSplit && byKind?.length ? (
            <span className="flex items-baseline gap-1.5" role="group" aria-label="Split the bar by">
              {(["attention", "kind"] as const).map((s) => {
                const on = (s === "kind") === kindView;
                return (
                  <button
                    key={s}
                    type="button"
                    className="hover:text-[var(--fg-muted)]"
                    style={{ color: on ? "var(--fg-muted)" : "var(--fg-faint)", textDecoration: on ? "underline" : undefined, textUnderlineOffset: 3 }}
                    aria-pressed={on}
                    data-testid={`review-progress-split-${s}`}
                    data-tip={s === "kind" ? "Split by the kind of unit" : "Split by attention"}
                    onClick={() => onSplit(s)}
                  >
                    <UiText>{s === "kind" ? "by kind" : "by attention"}</UiText>
                  </button>
                );
              })}
            </span>
          ) : null}
        </span>
        <span
          className="flex-none font-medium tabular-nums"
          style={{ color: progress.done ? "var(--ok)" : "var(--fg-muted)" }}
          data-testid="review-progress-percent"
          data-tip="Changed lines read, must read and skim"
        >
          <UiText>{progress.done ? "all read" : `${progress.percent}%`}</UiText>
        </span>
      </div>
      <div className="flex min-w-0 items-start gap-[3px]">
        {kindView
          ? byKind!.map((g) => {
              const style = g.kind ? KIND_STYLE[g.kind] : null;
              const name = style ? style.label[0].toUpperCase() + style.label.slice(1) : "No unit";
              return (
                <Segment
                  key={g.kind ?? "none"}
                  id={g.kind ?? "none"}
                  name={name}
                  ink={style?.color ?? "var(--fg-faint)"}
                  track={style?.bg ?? "var(--border)"}
                  counts={g}
                  onOpen={onOpenKind && (() => onOpenKind(g.kind))}
                />
              );
            })
          : shown.map((g) => (
              <Segment
                key={g.attention}
                id={g.attention}
                name={LABEL[g.attention]}
                note={g.attention === "skip" ? " (doesn't count toward the total)" : ""}
                ink={INK[g.attention]}
                track={TRACK[g.attention]}
                counts={g}
                onOpen={onOpenGroup && (() => onOpenGroup(g.attention))}
              />
            ))}
      </div>
    </div>
  );
}

function Segment({
  id,
  name,
  note = "",
  ink,
  track,
  counts: g,
  onOpen,
}: {
  id: string;
  name: string;
  note?: string;
  ink: string;
  track: string;
  counts: Counts;
  onOpen?: () => void;
}) {
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
  const label = width >= 84 ? `${name} ${percent}%` : width >= 30 ? `${percent}%` : "";
  const tip =
    `${name}${note}: ${g.read} of ${g.lines} lines` +
    (g.units ? `, ${g.unitsDone} of ${g.units} ${g.units === 1 ? "unit" : "units"}` : "") +
    (g.reread ? `, ${g.reread} changed since read` : "");
  return (
    <button
      ref={ref}
      type="button"
      className="group/seg flex min-w-[10px] flex-col items-stretch gap-1 text-left disabled:cursor-default"
      // Each part as wide as its share of the lines; a small one still shows.
      style={{ flexGrow: g.lines, flexBasis: 0 }}
      data-testid={`review-progress-${id}`}
      data-read={g.read}
      data-lines={g.lines}
      data-tip={tip}
      aria-label={tip}
      disabled={done || !onOpen}
      onClick={() => onOpen?.()}
    >
      <span
        className="relative block h-1.5 overflow-hidden rounded-full transition-[filter] group-hover/seg:brightness-95 group-disabled/seg:brightness-100"
        style={{ background: track }}
      >
        <span
          className="absolute inset-y-0 left-0 transition-[width] duration-300"
          style={{ width: pct(g.read), background: ink }}
        />
        {g.reread ? (
          <span
            className="absolute inset-y-0"
            style={{
              left: pct(g.read),
              width: pct(g.reread),
              background: `repeating-linear-gradient(135deg, ${ink} 0 2px, transparent 2px 4px)`,
            }}
          />
        ) : null}
      </span>
      {label ? (
        <span
          className="truncate text-2xs leading-none tabular-nums transition-colors group-hover/seg:text-[var(--fg-muted)] group-disabled/seg:text-[var(--fg-faint)]"
          style={{ color: "var(--fg-faint)" }}
          data-testid={`review-progress-${id}-label`}
        >
          <UiText>{label}</UiText>
        </span>
      ) : null}
    </button>
  );
}
