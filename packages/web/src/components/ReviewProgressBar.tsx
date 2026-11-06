import type { Attention } from "../api/types";
import type { GroupProgress, ReviewProgress } from "../lib/reviewProgress";
import { attentionColor, attentionSoftBg } from "./Chips";
import { UiText } from "./UiText";

const LABEL: Record<Attention, string> = { "must-read": "Must read", skim: "Skim", skip: "Skip" };

/**
 * Where the reading stands, held at the top of the sidebar: one bar in three
 * parts, must read, skim and skip, each as wide as its share of the changed
 * lines and filled as far as it is read. Lines read before a revision changed
 * them are hatched, owed again. The percentage counts must read and skim;
 * skip is shown, never owed. A part opens the first unread unit of its kind.
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
      className="flex flex-none items-center gap-2.5 border-b px-3 py-2"
      style={{ borderColor: "var(--border)" }}
      data-testid="review-progress"
      data-done={progress.done || undefined}
    >
      <div className="flex min-w-0 flex-1 items-center gap-[3px]">
        {shown.map((g) => (
          <Segment key={g.attention} group={g} onOpen={onOpenGroup} />
        ))}
      </div>
      <span
        className="flex-none text-2xs font-medium tabular-nums"
        style={{ color: progress.done ? "var(--ok)" : "var(--fg-muted)" }}
        data-testid="review-progress-percent"
        data-tip="Changed lines read, must read and skim"
      >
        <UiText>{progress.done ? "all read" : `${progress.percent}%`}</UiText>
      </span>
    </div>
  );
}

function Segment({ group: g, onOpen }: { group: GroupProgress; onOpen?: (attention: Attention) => void }) {
  const ink = attentionColor(g.attention);
  const pct = (n: number) => `${(n / g.lines) * 100}%`;
  const done = g.hunksRead === g.hunks;
  const tip = [
    `${LABEL[g.attention]}: ${g.read} of ${g.lines} changed lines read`,
    g.units ? `${g.unitsDone} of ${g.units} ${g.units === 1 ? "unit" : "units"} done` : null,
    g.reread ? `${g.reread} lines changed since you read them` : null,
    g.attention === "skip" ? "not counted" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      type="button"
      className="group/seg relative h-3 min-w-[10px] py-[3px] disabled:cursor-default"
      // Each part as wide as its share of the lines; a small one still shows.
      style={{ flexGrow: g.lines, flexBasis: 0 }}
      data-testid={`review-progress-${g.attention}`}
      data-read={g.read}
      data-lines={g.lines}
      data-tip={done || !onOpen ? tip : `${tip}. Click to open the next unread one`}
      aria-label={tip}
      disabled={done || !onOpen}
      onClick={() => onOpen?.(g.attention)}
    >
      <span
        className="relative block h-full overflow-hidden rounded-full transition-[filter] group-hover/seg:brightness-95 group-disabled/seg:brightness-100"
        style={{ background: attentionSoftBg(g.attention), opacity: g.attention === "skip" ? 0.7 : 1 }}
      >
        <span className="absolute inset-y-0 left-0 transition-[width] duration-300" style={{ width: pct(g.read), background: ink }} />
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
    </button>
  );
}
