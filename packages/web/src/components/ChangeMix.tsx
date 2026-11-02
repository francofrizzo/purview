import { useState } from "react";
import { createPortal } from "react-dom";
import type { FileEntry } from "../api/types";
import { changeMix, formatShare, type ChangeKind, type ChangeMix as Mix } from "../lib/changeMix";
import { useSettings } from "../lib/settings";
import { DiffSizeStat } from "./Chips";
import { IconChevron } from "./icons";

/** `short` is for the unit's one line, where "documentation" alone would wrap it. */
const CHANGE_LOOK: Record<ChangeKind, { label: string; short: string; color: string }> = {
  implementation: { label: "Implementation", short: "implementation", color: "var(--kind-core)" },
  tests: { label: "Tests", short: "tests", color: "var(--kind-tests)" },
  // Yellow, not the docs chip's grey: two greys side by side in a thin bar
  // read as one. The theme's yellow, which turns orange where yellow is faint.
  docs: { label: "Documentation", short: "docs", color: "var(--warn)" },
  generated: { label: "Generated", short: "generated", color: "var(--fg-faint)" },
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

/**
 * The lines of each kind, its share, and the total. Given `expand`, each kind
 * opens into the files counted under it, so a misplaced file shows.
 */
function ChangeTable({
  mix,
  expand,
}: {
  mix: Mix;
  expand?: { open: ReadonlySet<ChangeKind>; toggle: (kind: ChangeKind) => void; onOpenFile?: (path: string) => void };
}) {
  const dot = (kind: ChangeKind) => <span className="h-2 w-2 flex-none rounded-full" style={{ background: CHANGE_LOOK[kind].color }} />;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-baseline gap-x-2 gap-y-1">
      {mix.rows.map((r) => {
        const open = expand?.open.has(r.kind) ?? false;
        return (
          <div key={r.kind} className="contents" data-testid={`change-row-${r.kind}`}>
            {expand ? (
              <button
                type="button"
                className="flex min-w-0 items-center gap-1.5 text-left hover:underline"
                style={{ color: "var(--fg)" }}
                aria-expanded={open}
                data-testid={`change-toggle-${r.kind}`}
                onClick={() => expand.toggle(r.kind)}
              >
                {dot(r.kind)}
                {CHANGE_LOOK[r.kind].label}
                <span className="text-2xs" style={{ color: "var(--fg-faint)" }}>
                  {r.files.length} {r.files.length === 1 ? "file" : "files"}
                </span>
                <IconChevron open={open} width={10} height={10} className="flex-none" />
              </button>
            ) : (
              <span className="flex items-center gap-1.5" style={{ color: "var(--fg)" }}>
                {dot(r.kind)}
                {CHANGE_LOOK[r.kind].label}
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
        Total
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
function ChangeBar({ mix, className }: { mix: Mix; className: string }) {
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

function ChangeCard({ mix, all, anchor }: { mix: Mix; all: boolean; anchor: DOMRect }) {
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - CARD_WIDTH - 8));
  return (
    <div
      role="tooltip"
      className="surface elev-2 pointer-events-none fixed z-[70] rounded px-3 py-2 text-xs tabular-nums"
      style={{ top: anchor.bottom + 6, left, width: CARD_WIDTH }}
      data-testid="change-card"
    >
      <ChangeTable mix={mix} />
      <p className="mt-1.5 text-2xs" style={{ color: "var(--fg-faint)" }}>
        {all ? "Click to count implementation lines" : "Click to count all lines"}
      </p>
    </div>
  );
}

/**
 * What the unit's lines are made of: a bar and the shares, with the lines on
 * hover. Shown for one kind too: "100% tests" says what the unit is.
 */
export function UnitMix({ files, hunkIds }: { files: FileEntry[]; hunkIds: readonly string[] }) {
  const mix = changeMix(files, new Set(hunkIds));
  if (!mix.rows.length) return null;
  return (
    <div
      // A caption of the files line above it: under its text, not its icon.
      className="-mt-0.5 flex items-start gap-2 pl-[18px] text-2xs leading-4 tabular-nums"
      style={{ color: "var(--fg-muted)" }}
      data-testid="unit-mix"
      data-tip={mix.rows.map((r) => `${CHANGE_LOOK[r.kind].label}: +${r.added} −${r.removed}`).join("\n")}
    >
      {/* The bar keeps its place on the first line; the shares wrap under themselves. */}
      <ChangeBar mix={mix} className="mt-[5px] h-1.5 w-14" />
      <span className="min-w-0">{mix.rows.map((r) => `${formatShare(r.percent)} ${CHANGE_LOOK[r.kind].short}`).join(" · ")}</span>
    </div>
  );
}
