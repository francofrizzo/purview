import type { BehaviorChange } from "../../api/types";
import { UnitNumber } from "../Chips";
import { InlineMarkdown } from "../Markdown";
import { SectionHead } from "../SectionHead";
import { UiText } from "../UiText";

/** A cell the analysis left empty: the behavior did not exist, or no longer does. */
const NONE = /^\s*[—–-]?\s*$/;
/** An `after` saying the behavior stays as `before` describes it. */
const SAME = /^\s*=\s*$/;

/**
 * What behaves differently once the PR merges, a row per behavior: before on
 * the diff's removed tint, after on its added tint, so it reads like the diff
 * the reader is about to open. A behavior that stays the same (`after` is
 * "=") is one outlined cell across both, after the ones that change. A row
 * whose code lives in one unit opens it.
 */
export function BehaviorTable({
  changes,
  numbers,
  units,
  onOpenUnit,
}: {
  changes: BehaviorChange[];
  numbers: Map<string, number>;
  units: Set<string>;
  onOpenUnit: (unitId: string) => void;
}) {
  // Room for a behavior's name on a line or two; before and after share the rest evenly.
  const cols = "sm:grid-cols-[minmax(8rem,14rem)_minmax(0,1fr)_minmax(0,1fr)_1.25rem]";
  return (
    <section data-testid="overview-behavior" data-section="behavior">
      <SectionHead title="Behavior changes" />
      {/* No padding of its own: the rows' cancels their negative margin, so the
          labels start where the cells' text does. */}
      <div className={`mb-1 hidden gap-x-2 text-2xs font-medium sm:grid ${cols}`} style={{ color: "var(--fg-faint)" }} aria-hidden>
        <span />
        <UiText className="px-2">Before</UiText>
        <UiText className="px-2">After</UiText>
        <span />
      </div>
      <ul className="flex flex-col gap-1">
        {[...changes.filter((c) => !SAME.test(c.after)), ...changes.filter((c) => SAME.test(c.after))].map((c, i) => {
          const unit = c.unit && units.has(c.unit) ? c.unit : undefined;
          const same = SAME.test(c.after);
          const body = (
            <>
              {/* What kind of change it is shows in the cells (a dash, an outline), not in a chip. */}
              <span className="pt-1.5 text-[13px] font-medium leading-5" style={{ color: "var(--fg)" }}>
                <InlineMarkdown text={c.what} />
              </span>
              {same ? (
                <BehaviorCell text={c.before} label="Before and after" wide />
              ) : (
                <>
                  <BehaviorCell text={c.before} tint="var(--del-bg)" label="Before" />
                  <BehaviorCell text={c.after} tint="var(--add-bg)" label="After" />
                </>
              )}
              <span className="hidden justify-center pt-1.5 sm:flex">
                {unit ? <UnitNumber number={numbers.get(unit) ?? 0} /> : null}
              </span>
            </>
          );
          const row = `grid grid-cols-1 gap-x-2 gap-y-1 rounded-md px-2 py-1 text-left ${cols}`;
          return (
            <li key={i} data-testid="behavior-change">
              {unit ? (
                <button
                  type="button"
                  className={`${row} -mx-2 w-[calc(100%+1rem)] transition-colors hover:bg-[var(--bg-hover)]`}
                  onClick={() => onOpenUnit(unit)}
                  data-tip="Open the unit that makes this change"
                >
                  {body}
                </button>
              ) : (
                <div className={`${row} -mx-2`}>{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** `tint`: the diff's colour for its side; without one, an outline (a behavior that stays the same). */
function BehaviorCell({ text, tint, label, wide }: { text: string; tint?: string; label: string; wide?: boolean }) {
  if (NONE.test(text)) {
    return (
      <span className="hidden px-2 py-1.5 text-[13px] leading-5 sm:block" style={{ color: "var(--fg-faint)" }} aria-label={`${label}: none`}>
        —
      </span>
    );
  }
  return (
    <span className={`rounded px-2 py-1.5 text-[13px] leading-5${wide ? " sm:col-span-2" : ""}`} style={{ color: "var(--fg)", ...(tint ? { background: tint } : { boxShadow: "inset 0 0 0 1px var(--border-strong)" }) }}>
      <UiText className="sr-only">{`${label}: `}</UiText>
      <InlineMarkdown text={text} />
    </span>
  );
}

