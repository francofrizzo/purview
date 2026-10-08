/**
 * The PR's reviews and conversation comments, for the summary strip: a
 * chronological timeline in the overlay, and each reviewer's standing verdict
 * as a cluster of marked avatars on the collapsed strip (GitHub's reviewers
 * box, in one line).
 *
 * Bodies here are often long (bot walkthroughs, CodeRabbit's review
 * summaries), so each one starts clamped to a few lines; an entry with nothing
 * to say ("maria approved") is a single line.
 */

import { useLayoutEffect, useRef, useState } from "react";
import { formatFullTimestamp } from "../lib/prList";
import { entryBody, verdictVerb, verdictsTitle, type ReviewerVerdict, type TimelineEntry, type Verdict } from "../lib/reviews";
import { AuthorAvatar } from "./AuthorAvatar";
import { Markdown } from "./Markdown";
import { withoutHeadings } from "./SummaryStrip";
import { BotChip, age } from "./Threads";
import { IconCheck, IconClose } from "./icons";

/** Collapsed body height: six lines of 20px. */
const CLAMP_PX = 120;

const STATE_LOOK: Record<Verdict, { label: string; bg: string; fg: string }> = {
  APPROVED: { label: "approved", bg: "var(--ok-soft)", fg: "var(--ok)" },
  CHANGES_REQUESTED: { label: "changes requested", bg: "var(--risk-soft)", fg: "var(--risk)" },
  COMMENTED: { label: "commented", bg: "var(--bg-inset)", fg: "var(--fg-muted)" },
  DISMISSED: { label: "dismissed", bg: "var(--bg-inset)", fg: "var(--fg-faint)" },
};

function StateChip({ state }: { state: Verdict }) {
  const look = STATE_LOOK[state];
  return (
    <span className="chip" data-testid={`review-state-${state}`} style={{ background: look.bg, color: look.fg }}>
      {state === "APPROVED" ? <IconCheck width={10} height={10} /> : state === "CHANGES_REQUESTED" ? <IconClose width={10} height={10} /> : null}
      {look.label}
    </span>
  );
}

/** "maria", "CodeRabbit", "franco (you)" — as the thread cards name people. */
function authorLabel(entry: TimelineEntry): { name: string; avatarName: string; bot: boolean } {
  const { author, isMine } = entry;
  if (author.bot && !isMine) {
    const name = author.botName ?? author.login.replace(/\[bot\]$/i, "");
    return { name, avatarName: name, bot: true };
  }
  return { name: isMine ? `${author.login} (you)` : author.login, avatarName: author.login, bot: false };
}

/** A body clamped (headings flattened: a bot's "## Walkthrough" is not a section title here) to a few lines, with "show more" when it actually overflows. */
function ClampedBody({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > CLAMP_PX + 8);
    measure();
    // Mermaid and images settle after the first paint.
    const ro = new ResizeObserver(measure);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [text]);

  const clamped = overflows && !expanded;
  return (
    <div className="mt-0.5">
      <div
        ref={ref}
        data-testid="review-body"
        data-clamped={clamped ? "true" : "false"}
        className="max-w-[72ch]"
        style={
          clamped
            ? {
                maxHeight: CLAMP_PX,
                overflow: "hidden",
                maskImage: "linear-gradient(to bottom, black calc(100% - 2.5rem), transparent)",
                WebkitMaskImage: "linear-gradient(to bottom, black calc(100% - 2.5rem), transparent)",
              }
            : undefined
        }
      >
        <Markdown text={withoutHeadings(text)} textClass="text-[13px] leading-[20px]" ink="var(--fg)" />
      </div>
      {overflows ? (
        <button
          type="button"
          data-testid="review-body-toggle"
          className="-ml-1.5 mt-0.5 rounded px-1.5 py-0.5 text-2xs transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
          style={{ color: "var(--fg-muted)" }}
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
        >
          {expanded ? "show less" : "show more"}
        </button>
      ) : null}
    </div>
  );
}

function GithubLink({ url, what }: { url: string; what: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="ml-auto flex-none rounded px-1 opacity-60 transition-opacity hover:underline hover:opacity-100"
      style={{ color: "var(--fg-muted)" }}
      title={`Open this ${what} on GitHub`}
      onClick={(e) => e.stopPropagation()}
    >
      ↗
    </a>
  );
}

function TimelineItem({ entry }: { entry: TimelineEntry }) {
  const who = authorLabel(entry);
  const body = entryBody(entry);
  const when = age(entry.at);
  const review = entry.kind === "review" ? entry.review : null;
  const inline = review?.commentCount ?? 0;
  const edited = entry.kind === "comment" && entry.comment.updatedAt && entry.comment.updatedAt !== entry.comment.createdAt;
  const url = review ? review.url : entry.kind === "comment" ? entry.comment.url : "";
  const meta = (
    <>
      {when ? (
        <span className="flex-none" style={{ color: "var(--fg-faint)" }} title={formatFullTimestamp(entry.at)}>
          {body ? "" : "· "}
          {when}
        </span>
      ) : null}
      {edited ? (
        <span className="flex-none" style={{ color: "var(--fg-faint)" }} title={`edited ${formatFullTimestamp(entry.comment.updatedAt!)}`}>
          · edited
        </span>
      ) : null}
      {inline > 0 ? (
        <span className="flex-none tabular-nums" style={{ color: "var(--fg-faint)" }} data-testid="review-inline-count">
          · {inline} inline {inline === 1 ? "comment" : "comments"}
        </span>
      ) : null}
      <GithubLink url={url} what={review ? "review" : "comment"} />
    </>
  );

  return (
    <li
      data-testid={`timeline-${entry.kind}-${entry.id}`}
      data-compact={body ? "false" : "true"}
      className="relative flex gap-2"
    >
      <span className="relative z-[1] mt-[3px] flex-none rounded-full" style={{ boxShadow: "0 0 0 3px var(--bg-raised)" }}>
        <AuthorAvatar author={who.avatarName} url={entry.author.avatarUrl} size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <header className="flex min-h-[22px] flex-wrap items-center gap-x-1.5 text-2xs">
          <span className="min-w-0 truncate font-medium" style={{ color: "var(--fg)" }} title={entry.author.login}>
            {who.name}
          </span>
          {who.bot ? <BotChip title={`${entry.author.login} — an AI reviewer`} /> : null}
          {body ? (
            review ? <StateChip state={review.state} /> : null
          ) : (
            // Nothing to read: the verb carries the state, GitHub-style.
            <span
              className="flex-none"
              style={{ color: review ? STATE_LOOK[review.state].fg : "var(--fg-muted)" }}
              data-testid={review ? `review-state-${review.state}` : undefined}
            >
              {review ? verdictVerb(review.state) : "commented"}
            </span>
          )}
          {meta}
        </header>
        {body ? <ClampedBody text={body} /> : null}
      </div>
    </li>
  );
}

/** The timeline: avatars on a rail, oldest first. */
export function ReviewTimeline({ entries, hidden }: { entries: TimelineEntry[]; hidden: number }) {
  return (
    <div data-testid="review-timeline">
      {entries.length ? (
        <ol className="relative flex flex-col gap-2.5">
          {/* the rail, threading the avatars */}
          <span
            aria-hidden
            className="absolute bottom-2 left-[7px] top-2 w-0.5"
            style={{ background: "var(--border)" }}
          />
          {entries.map((e) => (
            <TimelineItem key={`${e.kind}:${e.id}`} entry={e} />
          ))}
        </ol>
      ) : null}
      {hidden ? (
        <p className="mt-2 text-2xs" style={{ color: "var(--fg-faint)" }} data-testid="review-timeline-hidden">
          {hidden} from AI reviewers hidden by your thread filters
        </p>
      ) : null}
    </div>
  );
}

const MARK: Record<Verdict, { bg: string; fg: string } | null> = {
  APPROVED: { bg: "var(--ok)", fg: "var(--bg-inset)" },
  CHANGES_REQUESTED: { bg: "var(--risk)", fg: "var(--bg-inset)" },
  COMMENTED: null,
  DISMISSED: null,
};

/** The collapsed strip's reviewers: an avatar each, marked ✓ or ✗ by their standing verdict. */
export function ReviewerVerdicts({ verdicts }: { verdicts: ReviewerVerdict[] }) {
  if (verdicts.length === 0) return null;
  return (
    <span
      className="flex flex-none items-center gap-1"
      data-testid="reviewer-verdicts"
      title={verdictsTitle(verdicts)}
    >
      {verdicts.map((v) => {
        const mark = MARK[v.verdict];
        const name = v.author.bot ? (v.author.botName ?? v.author.login) : v.author.login;
        return (
          <span
            key={v.author.login}
            className="relative inline-flex flex-none"
            data-testid={`verdict-${v.author.login}`}
            data-verdict={v.verdict}
            style={mark ? undefined : { opacity: 0.6 }}
          >
            <AuthorAvatar author={name} url={v.author.avatarUrl} size={16} />
            {mark ? (
              <span
                aria-hidden
                className="absolute -bottom-[3px] -right-[3px] inline-flex h-[10px] w-[10px] items-center justify-center rounded-full"
                style={{ background: mark.bg, color: mark.fg, boxShadow: "0 0 0 1.5px var(--bg-inset)" }}
              >
                {v.verdict === "APPROVED" ? (
                  <IconCheck width={8} height={8} strokeWidth={2.4} />
                ) : (
                  <IconClose width={7} height={7} strokeWidth={2.4} />
                )}
              </span>
            ) : null}
          </span>
        );
      })}
    </span>
  );
}

/**
 * The same standing verdicts as a list, one reviewer per line — for the
 * finish-review dialog, where "who already approved, who is blocking" is
 * part of the decision rather than a glance.
 */
export function ReviewerVerdictList({ verdicts }: { verdicts: ReviewerVerdict[] }) {
  return (
    <ul className="mt-1.5 flex flex-col gap-1" data-testid="reviewer-verdict-list">
      {verdicts.map((v) => {
        const name = v.author.bot ? (v.author.botName ?? v.author.login) : v.author.login;
        const mark = MARK[v.verdict];
        return (
          <li
            key={v.author.login}
            className="flex items-center gap-1.5 text-xs"
            data-testid={`verdict-row-${v.author.login}`}
            data-verdict={v.verdict}
          >
            <AuthorAvatar author={name} url={v.author.avatarUrl} size={16} />
            <span style={{ color: "var(--fg)" }}>{v.isMine ? "You" : name}</span>
            {v.author.bot ? <BotChip /> : null}
            <span className="inline-flex items-center gap-1" style={{ color: mark ? mark.bg : "var(--fg-muted)" }}>
              {v.verdict === "APPROVED" ? <IconCheck width={11} height={11} /> : null}
              {v.verdict === "CHANGES_REQUESTED" ? <IconClose width={10} height={10} /> : null}
              {verdictVerb(v.verdict)}
            </span>
            <span className="text-2xs" style={{ color: "var(--fg-faint)" }} title={formatFullTimestamp(v.at)}>
              {age(v.at)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
