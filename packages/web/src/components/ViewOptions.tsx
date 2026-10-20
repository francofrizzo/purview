import { useRef, useState } from "react";
import type { RemoteAuthor, RemoteThread } from "../api/types";
import type { DiffViewMode } from "../lib/settings";
import type { ThreadFilters } from "../lib/threads";
import { FloatingPanel } from "./FloatingPanel";
import { ThreadFilterFields } from "./Threads";
import { IconViewOptions } from "./icons";

/**
 * How the diff is drawn and what it lists, behind one button: the layout,
 * wrapping, folding skippable hunks, hiding read units and the GitHub thread
 * filters. These are set
 * once and left; they do not need a place on screen while reading.
 */
export function ViewOptions({
  viewMode,
  onViewMode,
  wrap,
  onWrap,
  narrow,
  foldSkippable,
  onFoldSkippable,
  hideReviewed,
  onHideReviewed,
  threads,
  posts,
  filters,
  hiddenThreads,
  onShowResolved,
  onShowAiReviewers,
  onBotHidden,
  diff = true,
}: {
  viewMode: DiffViewMode;
  onViewMode: (m: DiffViewMode) => void;
  wrap: boolean;
  onWrap: (w: boolean) => void;
  /** split was asked for but the pane is too narrow for it */
  narrow?: boolean;
  foldSkippable: boolean;
  onFoldSkippable: (v: boolean) => void;
  hideReviewed: boolean;
  onHideReviewed: (v: boolean) => void;
  threads: RemoteThread[];
  posts?: readonly RemoteAuthor[];
  filters: ThreadFilters;
  hiddenThreads: number;
  onShowResolved: (v: boolean) => void;
  onShowAiReviewers: (v: boolean) => void;
  onBotHidden: (key: string, hidden: boolean) => void;
  /**
   * The diff's own options apply. Off in the overview, where only the thread
   * filters do (they shape its reviews); the button stays either way, so the
   * top bar never shifts under the pointer between views.
   */
  diff?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const filtering = !filters.showResolved || !filters.showAiReviewers || filters.hiddenBots.length > 0;
  const threadFields = threads.length > 0 || (posts?.length ?? 0) > 0;
  const empty = !diff && !threadFields;
  return (
    <span ref={ref} className="relative inline-flex flex-none">
      <button
        type="button"
        className="btn"
        data-testid="view-options"
        aria-expanded={open}
        aria-label="View options"
        data-tip={
          empty
            ? "Nothing to adjust in the overview"
            : hiddenThreads
              ? `View options · ${hiddenThreads} GitHub threads hidden`
              : "View options"
        }
        disabled={empty}
        onClick={() => setOpen((v) => !v)}
        style={open ? { background: "var(--bg-hover)" } : undefined}
      >
        <IconViewOptions width={13} height={13} />
        {filtering || (diff && hideReviewed) ? (
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--accent)" }} />
        ) : null}
      </button>
      {open ? (
        <FloatingPanel anchorRef={ref} onClose={() => setOpen(false)} label="View options" className="w-64 p-2.5 text-xs">
          {diff ? (
            <>
              <div className="mb-1.5 text-2xs font-semibold" style={{ color: "var(--fg-muted)" }}>
                Diff
              </div>
              <div
                role="group"
                aria-label="Diff layout"
                className="mb-1.5 grid grid-cols-2 gap-0.5 rounded-md p-0.5"
                style={{ background: "var(--bg-inset)" }}
              >
                {(["unified", "split"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    data-testid={`layout-${m}`}
                    aria-pressed={viewMode === m}
                    data-tip-key="d"
                    onClick={() => onViewMode(m)}
                    className="rounded px-2 py-1 capitalize transition-colors"
                    style={
                      viewMode === m
                        ? { background: "var(--bg-raised)", color: "var(--fg)", boxShadow: "0 0 0 1px var(--border)" }
                        : { color: "var(--fg-muted)" }
                    }
                  >
                    {m}
                  </button>
                ))}
              </div>
              {narrow && viewMode === "split" ? (
                <p className="mb-1.5 text-2xs leading-4" style={{ color: "var(--fg-faint)" }}>
                  Too narrow for side by side right now; shown unified.
                </p>
              ) : null}
              <Check testId="toggle-wrap" checked={wrap} onChange={onWrap} label="Wrap long lines" kbd="w" />
              <Check
                testId="fold-skippable"
                checked={foldSkippable}
                onChange={onFoldSkippable}
                label="Fold skippable hunks"
                kbd="Z"
                hint="Hunks the analysis says you can skip; off, they show muted"
              />
              <Check
                testId="hide-reviewed-units"
                checked={hideReviewed}
                onChange={onHideReviewed}
                label="Hide read units"
                hint="The unit you are reading stays"
              />
            </>
          ) : null}
          {threadFields ? (
            <div className={diff ? "mt-2.5 border-t pt-2.5" : undefined} style={{ borderColor: "var(--border)" }}>
              <ThreadFilterFields
                filters={filters}
                threads={threads}
                posts={posts}
                onShowResolved={onShowResolved}
                onShowAiReviewers={onShowAiReviewers}
                onBotHidden={onBotHidden}
              />
            </div>
          ) : null}
        </FloatingPanel>
      ) : null}
    </span>
  );
}

function Check({
  checked,
  onChange,
  label,
  kbd,
  hint,
  testId,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  kbd?: string;
  hint?: string;
  testId: string;
}) {
  return (
    <label
      className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-[var(--bg-hover)]"
      data-tip={hint}
      style={{ color: "var(--fg)" }}
    >
      <input
        type="checkbox"
        data-testid={testId}
        aria-pressed={checked}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: "var(--accent)" }}
      />
      <span className="min-w-0 flex-1">{label}</span>
      {kbd ? <kbd>{kbd}</kbd> : null}
    </label>
  );
}
