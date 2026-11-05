import { useState } from "react";
import { createPortal } from "react-dom";
import type { FileEntry } from "../api/types";
import { changeMix, formatShare, type ChangeKind, type ChangeMix as Mix } from "../lib/changeMix";
import { LINE_COUNTS, useSettings, type LineCounts } from "../lib/settings";
import { DiffSizeStat } from "./Chips";
import { IconChevron } from "./icons";
import { UiText } from "./UiText";

/** `short` is for the unit's one line, where "documentation" alone would wrap it. */
export const CHANGE_LOOK: Record<ChangeKind, { label: string; short: string; color: string }> = {
  implementation: { label: "Implementation", short: "implementation", color: "var(--kind-core)" },
  tests: { label: "Tests", short: "tests", color: "var(--kind-tests)" },
  // Yellow, not the docs chip's grey: two greys side by side in a thin bar
  // read as one. The theme's yellow, which turns orange where yellow is faint.
  docs: { label: "Documentation", short: "docs", color: "var(--warn)" },
  generated: { label: "Generated", short: "generated", color: "var(--fg-faint)" },
};

const CARD_WIDTH = 248;

/** What each count adds up, for the card; any count short of every line carries the mark. */
const COUNTS_LOOK: Record<LineCounts, { counts: string; mark: string | null }> = {
  implementation: { counts: "implementation lines", mark: "✱" },
  authored: { counts: "all lines but generated ones", mark: "✱" },
  all: { counts: "all lines", mark: null },
};

/** The kinds each count adds up. */
const COUNTED: Record<LineCounts, ReadonlySet<ChangeKind>> = {
  implementation: new Set(["implementation"]),
  authored: new Set(["implementation", "tests", "docs"]),
  all: new Set(["implementation", "tests", "docs", "generated"]),
};

/**
 * The PR's size in the header. A diff is often mostly tests and generated
 * files, so it counts the implementation's lines by default, marked as such;
 * hovering shows the rest, a click moves on to every line but generated ones,
 * then to every line. A count that would read the same as the one before it
 * is passed over. A PR of one kind has nothing to tell apart and reads as the
 * plain stat.
 */
export function ChangeSize({ files }: { files: FileEntry[] }) {
  const { settings, update } = useSettings();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const mix = changeMix(files);
  const total = { files: files.length, additions: mix.added, deletions: mix.removed };
  const implementation = mix.rows.find((r) => r.kind === "implementation");
  if (mix.rows.length < 2 || !implementation) return <DiffSizeStat size={total} />;
  const sum = (mode: LineCounts) => {
    const rows = mix.rows.filter((r) => COUNTED[mode].has(r.kind));
    return { ...total, additions: rows.reduce((n, r) => n + r.added, 0), deletions: rows.reduce((n, r) => n + r.removed, 0) };
  };
  // The counts that say something different, in order.
  const modes = LINE_COUNTS.filter((m, i) => {
    if (i === 0) return true;
    const prev = mix.rows.filter((r) => COUNTED[LINE_COUNTS[i - 1]].has(r.kind)).length;
    return mix.rows.filter((r) => COUNTED[m].has(r.kind)).length !== prev;
  });
  const mode = modes.includes(settings.lineCounts) ? settings.lineCounts : modes[modes.length - 1];
  const nextMode = modes[(modes.indexOf(mode) + 1) % modes.length];
  const size = sum(mode);
  const mark = COUNTS_LOOK[mode].mark;
  const show = (e: { currentTarget: HTMLElement }) => setAnchor(e.currentTarget.getBoundingClientRect());
  const hide = () => setAnchor(null);
  return (
    <>
      <button
        type="button"
        className="inline-flex flex-none items-center gap-1 rounded transition-opacity hover:opacity-80"
        data-counts={mode}
        data-testid="change-size"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={() => update({ lineCounts: nextMode })}
      >
        <DiffSizeStat size={size} tip={false} />
        {mark ? (
          <span aria-label={`${COUNTS_LOOK[mode].counts} only`} style={{ color: "var(--fg-faint)" }} data-testid="change-size-mark">
            {mark}
          </span>
        ) : null}
      </button>
      {anchor ? createPortal(<ChangeCard mix={mix} mode={mode} next={nextMode} anchor={anchor} />, document.body) : null}
    </>
  );
}

/**
 * The lines of each kind, its share, and the total. Given `expand`, each kind
 * opens into the files counted under it, so a misplaced file shows.
 */
function ChangeTable({
  mix,
  expand,
  counted,
}: {
  mix: Mix;
  /** the kinds the header counts; the others recede */
  counted?: ReadonlySet<ChangeKind>;
  expand?: { open: ReadonlySet<ChangeKind>; toggle: (kind: ChangeKind) => void; onOpenFile?: (path: string) => void };
}) {
  const dot = (kind: ChangeKind) => <span className="h-2 w-2 flex-none rounded-full" style={{ background: CHANGE_LOOK[kind].color }} />;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-baseline gap-x-2 gap-y-1">
      {mix.rows.map((r) => {
        const open = expand?.open.has(r.kind) ?? false;
        return (
          <div
            key={r.kind}
            className={`contents${counted && !counted.has(r.kind) ? " [&>*]:opacity-50" : ""}`}
            data-testid={`change-row-${r.kind}`}
          >
            {expand ? (
              <button
                type="button"
                className="flex min-w-0 items-center gap-1.5 text-left"
                style={{ color: "var(--fg)" }}
                aria-expanded={open}
                data-testid={`change-toggle-${r.kind}`}
                onClick={() => expand.toggle(r.kind)}
              >
                {dot(r.kind)}
                <UiText>{CHANGE_LOOK[r.kind].label}</UiText>
                <span className="text-2xs" style={{ color: "var(--fg-faint)" }}>
                  <UiText>{`${r.files.length} ${r.files.length === 1 ? "file" : "files"}`}</UiText>
                </span>
                <IconChevron open={open} width={10} height={10} className="flex-none" />
              </button>
            ) : (
              <span className="flex items-center gap-1.5" style={{ color: "var(--fg)" }}>
                {dot(r.kind)}
                <UiText>{CHANGE_LOOK[r.kind].label}</UiText>
              </span>
            )}
            <span className="text-right text-2xs" style={{ color: "var(--fg-faint)" }}>
              {formatShare(r.percent)}
            </span>
            <span className="text-right" style={{ color: "var(--ok)" }}>
              +{r.added}
            </span>
            <span className="text-right" style={{ color: "var(--risk)" }}>
              −{r.removed}
            </span>
            {open
              ? r.files.map((f) => (
                  <div key={f.path} className="contents text-2xs" data-testid={`change-file-${f.path}`}>
                    <button
                      type="button"
                      className="col-span-2 min-w-0 truncate pl-3.5 text-left font-mono hover:underline"
                      style={{ color: "var(--fg-muted)" }}
                      data-tip={f.path}
                      onClick={() => expand?.onOpenFile?.(f.path)}
                    >
                      {f.path}
                    </button>
                    <span className="text-right" style={{ color: "var(--ok)" }}>
                      {f.added ? `+${f.added}` : ""}
                    </span>
                    <span className="text-right" style={{ color: "var(--risk)" }}>
                      {f.removed ? `−${f.removed}` : ""}
                    </span>
                  </div>
                ))
              : null}
          </div>
        );
      })}
      <span className="col-span-full my-0.5 border-t" style={{ borderColor: "var(--border)" }} />
      <span className="col-span-2" style={{ color: "var(--fg)" }}>
        <UiText>Total</UiText>
      </span>
      <span className="text-right" style={{ color: "var(--ok)" }}>
        +{mix.added}
      </span>
      <span className="text-right" style={{ color: "var(--risk)" }}>
        −{mix.removed}
      </span>
    </div>
  );
}

/** A row of the kinds in proportion: the same look in a unit and in the overview. */
export function ChangeBar({ mix, className }: { mix: Mix; className: string }) {
  return (
    <span className={`flex flex-none gap-px overflow-hidden rounded-full ${className}`} aria-hidden>
      {mix.rows.map((r) => (
        <span key={r.kind} style={{ width: `${r.percent}%`, background: CHANGE_LOOK[r.kind].color }} />
      ))}
    </span>
  );
}

/** The overview's size: the kinds in proportion, over the table. */
export function ChangeBreakdown({ mix, onOpenFile }: { mix: Mix; onOpenFile?: (path: string) => void }) {
  const [open, setOpen] = useState<ReadonlySet<ChangeKind>>(new Set());
  const toggle = (kind: ChangeKind) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  return (
    <div className="max-w-xl text-[13px] tabular-nums" data-testid="change-breakdown">
      <ChangeBar mix={mix} className="mb-3 h-1.5 w-full" />
      <ChangeTable mix={mix} expand={{ open, toggle, onOpenFile }} />
    </div>
  );
}

function ChangeCard({ mix, mode, next, anchor }: { mix: Mix; mode: LineCounts; next: LineCounts; anchor: DOMRect }) {
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - CARD_WIDTH - 8));
  return (
    <div
      role="tooltip"
      className="surface elev-2 pointer-events-none fixed z-[70] rounded px-3 py-2 text-xs tabular-nums"
      style={{ top: anchor.bottom + 6, left, width: CARD_WIDTH }}
      data-testid="change-card"
    >
      <ChangeTable mix={mix} counted={COUNTED[mode]} />
      <p className="mt-1.5 text-2xs" style={{ color: "var(--fg-faint)" }}>
        <UiText>{`Counting ${COUNTS_LOOK[mode].counts}. Click to count ${COUNTS_LOOK[next].counts}`}</UiText>
      </p>
    </div>
  );
}
