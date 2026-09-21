/**
 * The analysis summary, collapsed to one line.
 *
 * A real summary is a multi-sentence paragraph; as a static block between the
 * top bar and the panes it cost 150–200px of the reader's vertical space for
 * something they read once. So the default state is a single-line strip (its
 * first sentence, ellipsized) and the full text arrives as an overlay that
 * drops *over* the panes — absolutely positioned, so the sidebar and the diff
 * never reflow when it opens.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";
import { IconChevron } from "./icons";

/**
 * Flatten a markdown summary down to its opening sentence.
 *
 * The strip has one line, so structure is noise: fences, heading markers,
 * bullets and inline emphasis all collapse into running text before the first
 * sentence is cut out of it.
 */
export function summaryLede(text: string): string {
  const flat = text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}([-*+]|\d+\.)\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // A sentence ends at .!? followed by whitespace (or the end of the text);
  // anything shorter is almost certainly an abbreviation, not a sentence.
  const m = flat.match(/^.*?[.!?](?=\s|$)/);
  const lede = (m?.[0] ?? flat).trim();
  return lede.length >= 12 ? lede : flat;
}

/** Headings would read as section titles in a two-paragraph overlay. */
export function withoutHeadings(text: string): string {
  return text.replace(/^(\s{0,3})#{1,6}\s+/gm, "$1");
}

/** How long the pointer must rest on the strip before it opens. */
export const HOVER_OPEN_MS = 250;
/**
 * Grace period after the pointer leaves. The overlay hangs *below* the strip,
 * so a reader moving into it necessarily crosses a sliver of neither — this is
 * the window that lets that diagonal move succeed.
 */
export const HOVER_CLOSE_MS = 150;

/** Touch and pen have no hover state to speak of; peeking would be a trap. */
function hoverCapable(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return !window.matchMedia("(hover: none)").matches;
}

export function SummaryStrip({
  summary,
  revision,
  viewed,
  total,
  open,
  onToggle,
  onClose,
}: {
  summary: string;
  revision: number;
  viewed: number;
  total: number;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const [peeking, setPeeking] = useState(false);

  // `open` is the *pinned* state, owned by the host (a click, or the `s` key).
  // `peeking` is this component's own transient hover state. Pinned always
  // wins, so leaving the strip cannot close something the reader clicked open.
  const shown = open || peeking;

  const clearTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };

  const scheduleOpen = useCallback(() => {
    if (!hoverCapable()) return;
    clearTimer();
    timer.current = window.setTimeout(() => setPeeking(true), HOVER_OPEN_MS);
  }, []);

  const scheduleClose = useCallback(() => {
    if (!hoverCapable()) return;
    clearTimer();
    timer.current = window.setTimeout(() => setPeeking(false), HOVER_CLOSE_MS);
  }, []);

  useEffect(() => clearTimer, []);

  // A pinned overlay is not a peek any more; drop the transient state so the
  // pin is the only thing holding it open.
  useEffect(() => {
    if (open) {
      clearTimer();
      setPeeking(false);
    }
  }, [open]);

  useEffect(() => {
    if (!shown) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        clearTimer();
        setPeeking(false);
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault(); // claimed: the page's own Escape leaves it alone
        clearTimer();
        setPeeking(false);
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [shown, onClose]);

  return (
    <div
      className="relative flex-none"
      ref={ref}
      data-peeking={peeking ? "true" : "false"}
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        data-testid="summary-strip"
        aria-expanded={shown}
        data-pinned={open ? "true" : "false"}
        title={
          open
            ? "Hide the analysis summary"
            : "Show the analysis summary (s) — hover to peek, click to pin"
        }
        onClick={() => {
          clearTimer();
          setPeeking(false);
          onToggle();
        }}
        className="flex w-full items-center gap-2 border-b px-3 py-1 text-left transition-colors"
        style={{ borderColor: "var(--border)", background: "var(--bg-inset)" }}
      >
        <span
          className="flex-none text-2xs uppercase leading-4 tracking-wider"
          style={{ color: "var(--fg-faint)" }}
        >
          summary
        </span>
        <span
          className="min-w-0 flex-1 truncate text-xs leading-4"
          style={{ color: "var(--fg-muted)" }}
        >
          {summaryLede(summary)}
        </span>
        <span
          className="flex-none text-2xs leading-4 tabular-nums"
          style={{ color: "var(--fg-faint)" }}
        >
          rev {revision}
          {total > 0 ? ` · ${viewed}/${total} viewed` : ""}
        </span>
        <IconChevron
          width={11}
          height={11}
          style={{ color: "var(--fg-faint)", transform: shown ? "rotate(90deg)" : "none" }}
        />
      </button>

      {shown ? (
        <div
          data-testid="summary-overlay"
          data-pinned={open ? "true" : "false"}
          className="absolute inset-x-0 top-full z-40 max-h-[40vh] overflow-y-auto border-b"
          style={{
            background: "var(--bg-raised)",
            borderColor: "var(--border-strong)",
            boxShadow: "0 12px 28px rgba(0, 0, 0, 0.35)",
          }}
        >
          <div className="max-w-[70ch] px-4 py-3 [&>div]:text-[13px] [&>div]:leading-[21px]">
            <Markdown text={withoutHeadings(summary.trim())} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
