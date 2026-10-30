import { useState } from "react";
import { createPortal } from "react-dom";
import type { FileEntry } from "../api/types";
import { changeMix, formatShare, type ChangeKind, type ChangeMix as Mix } from "../lib/changeMix";
import { useSettings } from "../lib/settings";
import { DiffSizeStat } from "./Chips";

const CHANGE_LOOK: Record<ChangeKind, { label: string; color: string }> = {
  implementation: { label: "Implementation", color: "var(--kind-core)" },
  tests: { label: "Tests", color: "var(--kind-tests)" },
  docs: { label: "Documentation", color: "var(--kind-docs)" },
  generated: { label: "Generated", color: "var(--fg-faint)" },
};

const CARD_WIDTH = 248;

/**
 * The PR's size in the header. A diff is often mostly tests and generated
 * files, so it counts the implementation's lines by default, marked as such;
 * hovering shows the rest, a click counts everything. A PR of one kind has
 * nothing to tell apart and reads as the plain stat.
 */
export function ChangeSize({ files }: { files: FileEntry[] }) {
  const { settings, update } = useSettings();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const mix = changeMix(files);
  const total = { files: files.length, additions: mix.added, deletions: mix.removed };
  const implementation = mix.rows.find((r) => r.kind === "implementation");
  if (mix.rows.length < 2 || !implementation) return <DiffSizeStat size={total} />;
  const all = settings.allLineCounts;
  const size = all ? total : { ...total, additions: implementation.added, deletions: implementation.removed };
  const show = (e: { currentTarget: HTMLElement }) => setAnchor(e.currentTarget.getBoundingClientRect());
  const hide = () => setAnchor(null);
  return (
    <>
      <button
        type="button"
        className="inline-flex flex-none items-center gap-1 rounded transition-opacity hover:opacity-80"
        aria-pressed={all}
        data-testid="change-size"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={() => update({ allLineCounts: !all })}
      >
        <DiffSizeStat size={size} tip={false} />
        {all ? null : (
          <span aria-label="implementation lines only" style={{ color: "var(--fg-faint)" }} data-testid="change-size-mark">
            ✱
          </span>
        )}
      </button>
      {anchor ? createPortal(<ChangeCard mix={mix} all={all} anchor={anchor} />, document.body) : null}
    </>
  );
}

function ChangeCard({ mix, all, anchor }: { mix: Mix; all: boolean; anchor: DOMRect }) {
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - CARD_WIDTH - 8));
  return (
    <div
      role="tooltip"
      className="surface elev-2 pointer-events-none fixed z-[70] rounded px-3 py-2 text-xs tabular-nums"
      style={{ top: anchor.bottom + 6, left, width: CARD_WIDTH }}
      data-testid="change-card"
    >
      <div className="grid grid-cols-[1fr_auto_auto_auto] items-baseline gap-x-2 gap-y-1">
        {mix.rows.map((r) => (
          <div key={r.kind} className="contents" data-testid={`change-row-${r.kind}`}>
            <span className="flex items-center gap-1.5" style={{ color: "var(--fg)" }}>
              <span className="h-2 w-2 flex-none rounded-full" style={{ background: CHANGE_LOOK[r.kind].color }} />
              {CHANGE_LOOK[r.kind].label}
            </span>
            <span className="text-right text-2xs" style={{ color: "var(--fg-faint)" }}>
              {formatShare(r.percent)}
            </span>
            <span className="text-right" style={{ color: "var(--ok)" }}>
              +{r.added}
            </span>
            <span className="text-right" style={{ color: "var(--risk)" }}>
              −{r.removed}
            </span>
          </div>
        ))}
        <span className="col-span-full my-0.5 border-t" style={{ borderColor: "var(--border)" }} />
        <span className="col-span-2" style={{ color: "var(--fg)" }}>
          Total
        </span>
        <span className="text-right" style={{ color: "var(--ok)" }}>
          +{mix.added}
        </span>
        <span className="text-right" style={{ color: "var(--risk)" }}>
          −{mix.removed}
        </span>
      </div>
      <p className="mt-1.5 text-2xs" style={{ color: "var(--fg-faint)" }}>
        {all ? "Click to count implementation lines" : "Click to count all lines"}
      </p>
    </div>
  );
}

/**
 * What the unit's lines are made of: a bar and the shares, with the lines on
 * hover. Nothing when they are all of one kind: the +/− above already says it.
 */
export function UnitMix({ files, hunkIds }: { files: FileEntry[]; hunkIds: readonly string[] }) {
  const mix = changeMix(files, new Set(hunkIds));
  if (mix.rows.length < 2) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs tabular-nums"
      style={{ color: "var(--fg-muted)" }}
      data-testid="unit-mix"
      data-tip={mix.rows.map((r) => `${CHANGE_LOOK[r.kind].label}: +${r.added} −${r.removed}`).join("\n")}
    >
      <span className="flex h-1.5 w-14 flex-none gap-px overflow-hidden rounded-full" aria-hidden>
        {mix.rows.map((r) => (
          <span key={r.kind} style={{ width: `${r.percent}%`, background: CHANGE_LOOK[r.kind].color }} />
        ))}
      </span>
      <span>{mix.rows.map((r) => `${formatShare(r.percent)} ${CHANGE_LOOK[r.kind].label.toLowerCase()}`).join(" · ")}</span>
    </div>
  );
}
