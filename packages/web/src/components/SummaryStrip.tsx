/**
 * The analysis summary — and the author's PR description, and the reviews it
 * has had on GitHub — collapsed to one line.
 *
 * A real summary is a multi-sentence paragraph; as a static block between the
 * top bar and the panes it cost 150–200px of the reader's vertical space for
 * something they read once. So the default state is a single-line strip (its
 * first sentence, ellipsized) and the full text arrives in a floating panel
 * that drops *over* the panes — absolutely positioned, so the sidebar and the
 * diff never reflow when it opens. Inside, Purview's summary, the author's
 * description and the GitHub reviews stack in that order; the tab row on top
 * is a jump bar — it scrolls to a section and underlines the one in view —
 * so everything is one scroll away and the two prose blocks never read as one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RemoteConversationComment, RemoteReview } from "../api/types";
import { buildTimeline, latestVerdicts, type RevisionContext } from "../lib/reviews";
import type { ThreadFilters } from "../lib/threads";
import { AuthorAvatar } from "./AuthorAvatar";
import { Markdown } from "./Markdown";
import { ReviewTimeline, ReviewerVerdicts } from "./Reviews";
import { IconChevron } from "./icons";

export type SummaryTab = "summary" | "description" | "reviews";

/**
 * Which section the jump bar underlines: the last one whose top has scrolled
 * past the panel's top edge (plus a little slack), or the first one.
 */
export function sectionInView(tops: number[], scrollTop: number, slack = 24): number {
  let i = 0;
  for (let k = 0; k < tops.length; k++) if (tops[k] - slack <= scrollTop) i = k;
  return i;
}

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
  authorAvatarUrl,
  reviews,
  conversation,
  filters,
  revisions,
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
  authorAvatarUrl?: string;
  /** the PR's reviews on GitHub, oldest first */
  reviews?: RemoteReview[];
  /** the PR's conversation-tab comments, oldest first */
  conversation?: RemoteConversationComment[];
  /** the review-thread filters, which hide AI reviewers here too */
  filters?: ThreadFilters;
  /** the PR's revisions, to say which one each verdict was given on */
  revisions?: RevisionContext;
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
  const verdicts = useMemo(
    () => latestVerdicts(reviews, { prAuthor: author, filters, revisions }),
    [reviews, author, filters, revisions],
  );
  const hasReviews = timeline.entries.length > 0 || timeline.hidden > 0;
  const available = useMemo(
    () =>
      [summary ? "summary" : null, description ? "description" : null, hasReviews ? "reviews" : null].filter(
        Boolean,
      ) as SummaryTab[],
    [summary, description, hasReviews],
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(0);
  const current: SummaryTab = available[Math.min(inView, available.length - 1)] ?? "summary";
  const sectionTops = () => {
    const panel = panelRef.current;
    if (!panel) return [];
    return available.map((t) => {
      const el = panel.querySelector<HTMLElement>(`[data-section="${t}"]`);
      return el ? el.offsetTop : 0;
    });
  };
  const onPanelScroll = () => {
    const panel = panelRef.current;
    if (!panel) return;
    // Scrolled to the end: the last section is the one being read even when
    // it is too short to reach the top.
    const atEnd = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 2;
    setInView(atEnd ? available.length - 1 : sectionInView(sectionTops(), panel.scrollTop));
  };
  const jumpTo = (t: SummaryTab) => {
    const panel = panelRef.current;
    const el = panel?.querySelector<HTMLElement>(`[data-section="${t}"]`);
    if (!panel || !el) return;
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    panel.scrollTo({ top: el.offsetTop, behavior: reduce ? "auto" : "smooth" });
    // Underline it now; a short last section may never reach the top on its own.
    setInView(available.indexOf(t));
  };
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
          data-tab={current}
          role="dialog"
          aria-label={what}
          className="surface absolute left-2 top-full z-40 mt-1 flex max-h-[70vh] w-[min(44rem,calc(100%-1rem))] flex-col overflow-hidden rounded-lg elev-3"
          style={{ borderColor: "var(--border-strong)" }}
        >
          {available.length > 1 ? (
            <div
              role="tablist"
              className="flex flex-none items-center gap-1 border-b px-2 pt-1.5"
              style={{ borderColor: "var(--border)" }}
            >
              {available.map((t) => (
                <SummaryTabButton key={t} id={t} active={t === current} onPick={jumpTo}>
                  {t === "summary" ? (
                    "Summary"
                  ) : t === "description" ? (
                    <>
                      {author ? <AuthorAvatar author={author} url={authorAvatarUrl} size={14} /> : null}
                      Description
                      {author ? <span style={{ color: "var(--fg-faint)" }}>{author}</span> : null}
                    </>
                  ) : (
                    <>
                      Reviews
                      <span style={{ color: "var(--fg-faint)" }}>{timeline.entries.length}</span>
                    </>
                  )}
                </SummaryTabButton>
              ))}
            </div>
          ) : null}
          <div ref={panelRef} onScroll={onPanelScroll} className="relative min-h-0 overflow-y-auto">
            {summary ? (
              // Purview's own read of the PR: one short paragraph, set as a
              // lede so it reads at a glance rather than as more fine print.
              <section
                data-section="summary"
                data-testid="pr-summary"
                className="px-5 py-4 [&>div]:text-[14px] [&>div]:leading-[23px]"
                style={{ color: "var(--fg)" }}
              >
                <Markdown text={withoutHeadings(summary.trim())} />
              </section>
            ) : null}
            {description ? (
              // The author's own words, headings and all: unlike the summary,
              // it is a document, and its structure is its own.
              <section
                data-section="description"
                data-testid="pr-description"
                className="px-5 py-4 [&>div]:text-[13px] [&>div]:leading-[21px]"
                style={summary ? { borderTop: "1px solid var(--border)" } : undefined}
              >
                {available.length > 1 ? (
                  <SectionTitle>
                    {author ? <AuthorAvatar author={author} url={authorAvatarUrl} size={14} /> : null}
                    Description{author ? <span style={{ color: "var(--fg-faint)" }}>by {author}</span> : null}
                  </SectionTitle>
                ) : null}
                <Markdown text={description} />
              </section>
            ) : null}
            {hasReviews ? (
              <section
                data-section="reviews"
                data-testid="pr-reviews"
                className="px-5 py-4"
                style={summary || description ? { borderTop: "1px solid var(--border)" } : undefined}
              >
                {available.length > 1 ? (
                  <SectionTitle>
                    Reviews<span style={{ color: "var(--fg-faint)" }}>on GitHub</span>
                  </SectionTitle>
                ) : null}
                <ReviewTimeline entries={timeline.entries} hidden={timeline.hidden} revisions={revisions} />
              </section>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold" style={{ color: "var(--fg-muted)" }}>
      {children}
    </h2>
  );
}

function SummaryTabButton({
  id,
  active,
  onPick,
  children,
}: {
  id: SummaryTab;
  active: boolean;
  onPick: (t: SummaryTab) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-testid={`summary-tab-${id}`}
      onClick={() => onPick(id)}
      className="-mb-px inline-flex items-center gap-1.5 border-b-2 px-2 pb-1.5 pt-1 text-xs font-medium transition-colors"
      style={{
        borderColor: active ? "var(--accent)" : "transparent",
        color: active ? "var(--fg)" : "var(--fg-muted)",
      }}
    >
      {children}
    </button>
  );
}
