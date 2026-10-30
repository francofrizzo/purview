import { useMemo, useRef, useState } from "react";
import type { Concept, PrDetail, RemoteConversationComment, RemoteReview, ReviewUnit } from "../api/types";
import { unitProgress } from "../lib/diffModel";
import { workUnits } from "../lib/generated";
import { buildTimeline, latestVerdicts, type RevisionContext } from "../lib/reviews";
import { sectionInView, withoutHeadings } from "../lib/summaryText";
import type { ThreadFilters } from "../lib/threads";
import { unitDisplayNumbers, unitDisplayOrder } from "../lib/unitOrder";
import { FileLegend, FileShape } from "./Shape";
import { AuthorAvatar } from "./AuthorAvatar";
import { InlineMarkdown, Markdown } from "./Markdown";
import { ReviewTimeline, ReviewerVerdicts } from "./Reviews";
import { IconArrowRight } from "./icons";

/**
 * The PR before its parts, from broad to narrow: why it exists (the
 * analysis's summary, in plain words), the words the PR leans on, where it
 * lands in the code, then what must be read;
 * the author's description, in their own words and whole, and what reviewers
 * said close it. One calm column; everything here is a way into the guide.
 * The bar on top jumps between the sections and underlines the one in view;
 * where the pane has margins to spare it is a contents list beside the text
 * instead (index.css).
 */
export function Overview({
  detail,
  summary,
  description,
  reviews,
  conversation,
  filters,
  revisions,
  onOpenUnit,
  onOpenFile,
}: {
  detail: PrDetail;
  summary: string;
  description: string;
  reviews?: RemoteReview[];
  conversation?: RemoteConversationComment[];
  filters?: ThreadFilters;
  revisions?: RevisionContext;
  onOpenUnit: (unitId: string) => void;
  /** a file in the tree opens in the Files view */
  onOpenFile: (path: string) => void;
}) {
  const { meta, state } = detail;
  const ordered = useMemo(() => unitDisplayOrder(state.units), [state.units]);
  const numbers = useMemo(() => unitDisplayNumbers(ordered), [ordered]);
  const work = workUnits(ordered);
  const timeline = useMemo(() => buildTimeline(reviews, conversation, filters), [reviews, conversation, filters]);
  const verdicts = useMemo(
    () => latestVerdicts(reviews, { prAuthor: meta.author, filters, revisions }),
    [reviews, meta.author, filters, revisions],
  );
  const hasReviews = timeline.entries.length > 0 || timeline.hidden > 0;
  const sections = [
    summary ? { id: "summary", label: "Summary" } : null,
    state.concepts?.length ? { id: "concepts", label: "Concepts" } : null,
    state.fileNotes ? { id: "files", label: "Where it lands" } : null,
    ordered.length ? { id: "reading", label: "Must read" } : null,
    description ? { id: "description", label: "Description" } : null,
    hasReviews ? { id: "reviews", label: "Reviews" } : null,
  ].filter((x): x is { id: string; label: string } => x !== null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(0);
  // A section was picked and the smooth scroll is still travelling: the
  // underline stays on it until the scroll lands, instead of flickering
  // through the sections it passes.
  const jumping = useRef<number | null>(null);
  const topOf = (id: string) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-section="${id}"]`);
    return el ? el.offsetTop - (barRef.current?.offsetHeight ?? 0) - 16 : 0;
  };
  const onScroll = () => {
    const pane = scrollRef.current;
    if (!pane) return;
    const atEnd = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2;
    if (jumping.current !== null) {
      if (!atEnd && Math.abs(pane.scrollTop - jumping.current) >= 2) return;
      jumping.current = null;
    }
    // Scrolled to the end: the last section is the one being read even when
    // it is too short to reach the top.
    setInView(atEnd ? sections.length - 1 : sectionInView(sections.map((x) => topOf(x.id)), pane.scrollTop));
  };
  const jumpTo = (index: number) => {
    const top = topOf(sections[index].id);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    jumping.current = top;
    scrollRef.current?.scrollTo({ top, behavior: reduce ? "auto" : "smooth" });
    // Underline it now; a short last section may never reach the top on its own.
    setInView(index);
  };
  const next =
    ordered.find((u) => {
      const p = unitProgress(detail, u);
      return p.total > 0 && p.viewed < p.total;
    }) ?? ordered[0];
  const started = ordered.some((u) => unitProgress(detail, u).viewed > 0);
  const close = ordered.filter((u) => u.attention === "must-read");
  const rest = restLine(
    close.length,
    ordered.filter((u) => u.attention === "skim").length,
    ordered.filter((u) => u.attention === "skip").length,
  );

  return (
    <div ref={scrollRef} className="overview-scroll quiet-scroll relative h-full overflow-y-auto" data-testid="overview" onScroll={onScroll}>
      {sections.length > 1 ? (
        <div
          ref={barRef}
          role="tablist"
          aria-label="Overview sections"
          data-testid="overview-jump"
          className="overview-jump sticky top-0 z-10 border-b px-6 pt-1.5 sm:px-10"
          style={{ borderColor: "var(--border)", background: "var(--bg-raised)" }}
        >
          <div className="mx-auto flex max-w-[54rem] flex-wrap items-end gap-1">
            {sections.map((x, i) => (
              <button
                key={x.id}
                type="button"
                role="tab"
                aria-selected={i === inView}
                data-testid={`overview-jump-${x.id}`}
                onClick={() => jumpTo(i)}
                className="-mb-px border-b-2 px-2 pb-1.5 pt-1 text-xs font-medium transition-colors"
                style={{
                  borderColor: i === inView ? "var(--accent)" : "transparent",
                  color: i === inView ? "var(--fg)" : "var(--fg-muted)",
                }}
              >
                {x.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {/* Text keeps a reading measure. */}
      <div className="flex flex-col gap-10 px-6 pb-16 pt-8 sm:px-10 [&>section]:mx-auto [&>section]:w-full [&>section]:max-w-[54rem]">
        {summary ? (
          <section data-testid="pr-summary" data-section="summary">
            <p className="mb-2 text-2xs" style={{ color: "var(--fg-faint)" }} data-testid="pr-summary-byline">
              Generated by Purview
            </p>
            <div className="[&>div]:text-[15px] [&>div]:leading-[25px]" style={{ color: "var(--fg)" }}>
              <Markdown text={withoutHeadings(summary.trim())} ink="var(--fg)" />
            </div>
          </section>
        ) : null}

        {state.concepts?.length ? <ConceptList concepts={state.concepts} /> : null}

        {/* Where the change lands, in the code: the shallow tree the analysis
            noted, before the units that read it. */}
        {state.fileNotes ? (
          <section data-testid="overview-files" data-section="files">
            <SectionHead title="Where it lands">
              <FileLegend files={detail.files.files} />
            </SectionHead>
            <FileShape files={detail.files.files} units={work} notes={state.fileNotes} onOpenFile={onOpenFile} />
          </section>
        ) : null}

        {/* Where to spend attention: only what needs a close read, each with
            the analysis's why. The rest is counted; the guide lists it all. */}
        {ordered.length ? (
          <section data-testid="reading-order" data-section="reading">
            <SectionHead title="Must read">
              {next ? (
                <button
                  type="button"
                  className="btn"
                  data-testid="start-reading"
                  onClick={() => onOpenUnit(next.id)}
                >
                  {started ? "Continue" : "Start reading"}
                  <IconArrowRight width={12} height={12} />
                </button>
              ) : null}
            </SectionHead>
            {close.length ? (
              <ol className="flex flex-col">
                {close.map((u) => (
                  <li key={u.id}>
                    <ReadingRow
                      unit={u}
                      number={numbers.get(u.id) ?? u.order}
                      progress={unitProgress(detail, u)}
                      onOpen={() => onOpenUnit(u.id)}
                    />
                  </li>
                ))}
              </ol>
            ) : null}
            {rest ? (
              // Under the titles' column when it follows rows, flush when alone.
              <p className={`text-xs ${close.length ? "mt-2 pl-8" : ""}`} style={{ color: "var(--fg-muted)" }} data-testid="reading-rest">
                {rest}
              </p>
            ) : null}
          </section>
        ) : null}

        {description ? (
          <section data-testid="pr-description" data-section="description">
            <SectionHead
              title={
                <span className="flex items-center gap-1.5">
                  {meta.author ? <AuthorAvatar author={meta.author} url={meta.authorAvatarUrl} size={16} /> : null}
                  Description
                  {meta.author ? (
                    <span className="text-[13px] font-normal" style={{ color: "var(--fg-faint)" }}>
                      by {meta.author}
                    </span>
                  ) : null}
                </span>
              }
            />
            <div className="[&>div]:text-[13px] [&>div]:leading-[21px]">
              <Markdown text={description} />
            </div>
          </section>
        ) : null}

        {hasReviews ? (
          <section data-testid="pr-reviews" data-section="reviews">
            <SectionHead title="Reviews">
              <ReviewerVerdicts verdicts={verdicts} />
            </SectionHead>
            <ReviewTimeline entries={timeline.entries} hidden={timeline.hidden} revisions={revisions} />
          </section>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The words the PR leans on, each with its meaning; the same meanings show on
 * hover wherever the guide uses them. The code's own names for a concept sit
 * faint beside it, so the reader can recognize them in the units.
 */
function ConceptList({ concepts }: { concepts: Concept[] }) {
  return (
    <section data-testid="overview-concepts" data-section="concepts">
      <SectionHead title="Concepts" />
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[minmax(8rem,auto)_1fr]">
        {concepts.map((c) => (
          <div key={c.term} className="contents" data-testid="concept">
            <dt className="flex flex-wrap items-baseline gap-x-1.5 text-[13px] font-medium leading-5" style={{ color: "var(--fg)" }}>
              {c.term}
              {c.isNew ? (
                <span className="chip" style={{ color: "var(--accent)", background: "var(--accent-soft)" }} data-testid="concept-new">
                  new
                </span>
              ) : null}
            </dt>
            <dd className="-mt-2 text-[13px] leading-5 sm:mt-0" style={{ color: "var(--fg-muted)" }}>
              {c.means}
              {/* The first names are enough to recognize it in the units;
                  the rest only feed the hover. */}
              {c.aka.length ? (
                <span className="ml-1.5 font-mono text-2xs" style={{ color: "var(--fg-faint)" }} data-tip="As the code and the guide call it">
                  {c.aka.slice(0, 2).join(" · ")}
                </span>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function restLine(close: number, skim: number, skip: number): string {
  const parts = [skim ? `${skim} to skim` : "", skip ? `${skip} to skip` : ""].filter(Boolean);
  if (!parts.length) return "";
  return close ? `Then ${parts.join(" and ")}.` : `Nothing needs a close read: ${parts.join(", ")}.`;
}

function SectionHead({ title, children }: { title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1">
      <h2 className="text-base font-semibold" style={{ color: "var(--fg)" }}>
        {title}
      </h2>
      {children ? <div className="ml-auto flex items-center gap-2">{children}</div> : null}
    </div>
  );
}

function ReadingRow({
  unit,
  number,
  progress,
  onOpen,
}: {
  unit: ReviewUnit;
  number: number;
  progress: { viewed: number; total: number };
  onOpen: () => void;
}) {
  const done = progress.total > 0 && progress.viewed === progress.total;
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid={`reading-row-${unit.id}`}
      className="group -mx-2 flex w-[calc(100%+1rem)] items-baseline gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-[var(--bg-hover)]"
    >
      <span className="w-5 flex-none text-right text-xs tabular-nums" style={{ color: "var(--fg-faint)" }}>
        {number}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className="block text-[13px] font-medium leading-5"
          style={{ color: done ? "var(--fg-muted)" : "var(--fg)" }}
        >
          <InlineMarkdown text={unit.title} />
        </span>
        {unit.attentionWhy ? (
          <span className="mt-0.5 block text-xs leading-[18px]" style={{ color: "var(--fg-faint)" }}>
            <InlineMarkdown text={unit.attentionWhy} />
          </span>
        ) : null}
      </span>
      <span
        className="flex-none text-2xs tabular-nums"
        style={{ color: done ? "var(--ok)" : "var(--fg-faint)" }}
      >
        {progress.total ? `${progress.viewed}/${progress.total}` : ""}
      </span>
    </button>
  );
}
