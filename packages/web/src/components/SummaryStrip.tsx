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

import { useEffect, useRef } from "react";
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

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <div className="relative flex-none" ref={ref}>
      <button
        type="button"
        data-testid="summary-strip"
        aria-expanded={open}
        title={open ? "Hide the analysis summary" : "Show the analysis summary (s)"}
        onClick={onToggle}
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
          style={{ color: "var(--fg-faint)", transform: open ? "rotate(90deg)" : "none" }}
        />
      </button>

      {open ? (
        <div
          data-testid="summary-overlay"
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
