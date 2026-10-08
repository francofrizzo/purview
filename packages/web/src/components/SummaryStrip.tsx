/**
 * The analysis summary — and the author's PR description, and the reviews it
 * has had on GitHub — collapsed to one line.
 *
 * A real summary is a multi-sentence paragraph; as a static block between the
 * top bar and the panes it cost 150–200px of the reader's vertical space for
 * something they read once. So the default state is a single-line strip (its
 * first sentence, ellipsized) and the full text arrives as an overlay that
 * drops *over* the panes — absolutely positioned, so the sidebar and the diff
 * never reflow when it opens.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RemoteConversationComment, RemoteReview } from "../api/types";
import { buildTimeline, latestVerdicts } from "../lib/reviews";
import type { ThreadFilters } from "../lib/threads";
import { Markdown } from "./Markdown";
import { ReviewTimeline, ReviewerVerdicts } from "./Reviews";
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
    .replace(/[`*]/g, "")
    // Emphasis underscores only; `get_balance` keeps its own.
    .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, "")
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

/**
 * The description as GitHub shows it: HTML comments (PR templates are full of
 * them) never reach the reader there, so they don't here either.
 */
export function visibleDescription(body: string | undefined): string {
  return (body ?? "").replace(/<!--[\s\S]*?(-->|$)/g, "").trim();
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
  description,
  author,
  reviews,
  conversation,
  filters,
  viewed,
  total,
  open,
  onToggle,
  onClose,
}: {
  /** the analysis summary; "" when the PR has not been analyzed */
  summary: string;
  /** the PR description, already through `visibleDescription`; "" for none */
  description: string;
  author?: string;
  /** the PR's reviews on GitHub, oldest first */
  reviews?: RemoteReview[];
  /** the PR's conversation-tab comments, oldest first */
  conversation?: RemoteConversationComment[];
  /** the review-thread filters, which hide AI reviewers here too */
  filters?: ThreadFilters;
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
  const timeline = useMemo(() => buildTimeline(reviews, conversation, filters), [reviews, conversation, filters]);
  const verdicts = useMemo(() => latestVerdicts(reviews, { prAuthor: author, filters }), [reviews, author, filters]);
  const hasReviews = timeline.entries.length > 0 || timeline.hidden > 0;
  const what =
    [summary ? "analysis summary" : "", description ? "PR description" : "", hasReviews ? "reviews" : ""]
      .filter(Boolean)
      .join(", ")
      .replace(/, ([^,]*)$/, " and $1") || "PR description";

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
            ? `Hide the ${what}`
            : `Show the ${what} (s) — hover to peek, click to pin`
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
          className="min-w-0 flex-1 truncate text-xs leading-4"
          style={{ color: "var(--fg-muted)" }}
        >
          {summary ? (
            summaryLede(summary)
          ) : description ? (
            <>
              <span style={{ color: "var(--fg-faint)" }}>Description · </span>
              {summaryLede(description)}
            </>
          ) : (
            <>
              <span style={{ color: "var(--fg-faint)" }}>Reviews · </span>
              {timeline.entries.length} on GitHub
            </>
          )}
        </span>
        {summary && description ? (
          <span
            className="hidden flex-none text-2xs leading-4 sm:inline"
            style={{ color: "var(--fg-faint)" }}
            data-testid="summary-strip-has-description"
          >
            + description
          </span>
        ) : null}
        <ReviewerVerdicts verdicts={verdicts} />
        <span
          className="flex-none text-2xs leading-4 tabular-nums"
          style={{ color: "var(--fg-faint)" }}
        >
          {total > 0 ? `${viewed}/${total} viewed` : ""}
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
          className={`absolute inset-x-0 top-full z-40 overflow-y-auto border-b ${
            description || hasReviews ? "max-h-[60vh]" : "max-h-[40vh]"
          }`}
          style={{
            background: "var(--bg-raised)",
            borderColor: "var(--border-strong)",
            boxShadow: "0 12px 28px rgba(0, 0, 0, 0.35)",
          }}
        >
          {summary ? (
            <section className="max-w-[70ch] px-4 py-3 [&>div]:text-[13px] [&>div]:leading-[21px]">
              {description ? <OverlayHeading>Analysis summary</OverlayHeading> : null}
              <Markdown text={withoutHeadings(summary.trim())} />
            </section>
          ) : null}
          {description ? (
            <section
              data-testid="pr-description"
              className="max-w-[80ch] px-4 py-3 [&>div]:text-[13px] [&>div]:leading-[21px]"
              style={summary ? { borderTop: "1px solid var(--border)" } : undefined}
            >
              <OverlayHeading>
                Description{author ? <span style={{ color: "var(--fg-faint)" }}> · by {author}</span> : null}
              </OverlayHeading>
              {/* The author's own words, headings and all: unlike the
                  summary, it is a document, and its structure is its own. */}
              <Markdown text={description} />
            </section>
          ) : null}
          {hasReviews ? (
            <section
              data-testid="pr-reviews"
              className="max-w-[80ch] px-4 py-3"
              style={summary || description ? { borderTop: "1px solid var(--border)" } : undefined}
            >
              <OverlayHeading>
                Reviews
                <span style={{ color: "var(--fg-faint)" }}> · on GitHub</span>
              </OverlayHeading>
              <ReviewTimeline entries={timeline.entries} hidden={timeline.hidden} />
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function OverlayHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-1.5 text-2xs font-semibold" style={{ color: "var(--fg-muted)" }}>
      {children}
    </h2>
  );
}
