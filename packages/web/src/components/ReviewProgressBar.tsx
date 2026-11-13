import { useEffect, useRef, useState } from "react";
import type { Attention } from "../api/types";
import type { ChangeKind } from "../lib/changeMix";
import type { KindProgress, ReviewProgress } from "../lib/reviewProgress";
import { CHANGE_LOOK } from "./ChangeMix";
import { IconCycle } from "./icons";
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

interface Counts {
  lines: number;
  read: number;
  reread: number;
  hunks: number;
  hunksRead: number;
  units?: number;
  unitsDone?: number;
}

const percentOf = (g: Counts) =>
  g.hunksRead === g.hunks ? 100 : Math.min(99, Math.floor((g.read / g.lines) * 100));

export type ProgressSplit = "attention" | "kind";

/**
 * Where the reading stands, held at the bottom of the sidebar: one bar in
 * parts, each as wide as its share of the changed lines and filled as far as
 * it is read. Split by attention (must read, skim, skip) or by what the
 * lines are (implementation, tests, docs, generated, in the change mix's
 * colors); a click on the title flips it. Lines read before a revision
 * changed them are hatched, owed again. The total counts must read and skim
 * either way; skip and generated are shown, never owed. A part opens the
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
  onOpenKind?: (kind: ChangeKind) => void;
}) {
  const shown = progress.groups.filter((g) => g.lines > 0);
  if (!shown.length) return null;
  const kindView = split === "kind" && !!byKind?.length;
  const canSplit = !!onSplit && !!byKind?.length;
  const title = (
    <>
      <UiText>Review progress</UiText>
      {canSplit ? (
        <span
          className="ml-1.5 inline-flex items-center gap-0.5 font-normal transition-colors group-hover/split:text-[var(--fg-muted)]"
          style={{ color: "var(--fg-faint)" }}
        >
          <UiText>{kindView ? "by kind" : "by attention"}</UiText>
          <IconCycle width={10} height={10} />
        </span>
      ) : null}
    </>
  );
  return (
    <div
      className="flex flex-none flex-col gap-1.5 border-t px-3 pb-2 pt-2"
      style={{ borderColor: "var(--border)" }}
      data-testid="review-progress"
      data-split={kindView ? "kind" : "attention"}
      data-done={progress.done || undefined}
    >
      <div className="flex items-baseline justify-between gap-2 text-2xs">
        {canSplit ? (
          <button
            type="button"
            className="group/split min-w-0 truncate text-left font-medium"
            style={{ color: "var(--fg-muted)" }}
            data-testid="review-progress-split"
            data-tip={kindView ? "Split by attention" : "Split by kind: implementation, tests, docs, generated"}
            onClick={() => onSplit!(kindView ? "attention" : "kind")}
          >
            {title}
          </button>
        ) : (
          <span className="font-medium" style={{ color: "var(--fg-muted)" }}>
            {title}
          </span>
        )}
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
              const look = CHANGE_LOOK[g.kind];
              return (
                <Segment
                  key={g.kind}
                  id={g.kind}
                  name={g.kind === "docs" ? "Docs" : look.label}
                  note={g.kind === "generated" ? " (doesn't count toward the total)" : ""}
                  ink={look.color}
                  // A soft tint of the kind's color: what is still unread
                  // shows its kind too.
                  track={`color-mix(in srgb, ${look.color} 24%, transparent)`}
                  counts={g}
                  // Never owed, so its size says little: a lockfile must not
                  // squeeze the parts that count.
                  maxWidth={g.kind === "generated" ? "12%" : undefined}
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
  maxWidth,
  onOpen,
}: {
  /** a cap on the part's share of the bar, whatever its lines */
  maxWidth?: string;
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
      style={{ flexGrow: g.lines, flexBasis: 0, maxWidth }}
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
