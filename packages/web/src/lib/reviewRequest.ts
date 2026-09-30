/**
 * How a pending review request reads: "asked you 3d ago", with a tooltip that
 * spells out when, by whom and how. Pure, so the formatting and the "overdue"
 * threshold are unit-testable apart from the component.
 */

import type { PrGithubState, ReviewRequest } from "../api/types";
import { formatFullTimestamp } from "./prList";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** Past this, whole weeks read better than a large day count. */
const WEEKS_AFTER_MS = 14 * DAY;

/**
 * Compact age: "just now" under a minute, then "Nm", "Nh", "Nd", and "Nw"
 * past 14 days. A negative age (clock skew) reads as "just now".
 */
export function formatCompactAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < MINUTE) return "just now";
  if (ageMs < HOUR) return `${Math.floor(ageMs / MINUTE)}m`;
  if (ageMs < DAY) return `${Math.floor(ageMs / HOUR)}h`;
  if (ageMs < WEEKS_AFTER_MS) return `${Math.floor(ageMs / DAY)}d`;
  return `${Math.floor(ageMs / WEEK)}w`;
}

const ageOf = (iso: string, now: Date) => now.getTime() - new Date(iso).getTime();

/**
 * "asked you 3d ago" / "asked your team just now"; "" for an unparseable
 * stamp. It names *you* on purpose: next to GitHub's "awaiting approval" chip,
 * a bare "requested" read as if every PR had been requested of the reader.
 */
export function formatRequestedAgo(
  iso: string,
  now: Date = new Date(),
  via: string = "you",
): string {
  const age = ageOf(iso, now);
  if (Number.isNaN(age)) return "";
  const compact = formatCompactAge(age);
  const who = via === "you" ? "you" : "your team";
  return compact === "just now" ? `asked ${who} just now` : `asked ${who} ${compact} ago`;
}

export type RequestAgeLevel = 0 | 1 | 2 | 3;

/**
 * How urgent a request's age reads: the highest level whose threshold (in
 * days) it has reached, so with [1, 3, 7] a 3-day-old request is level 2.
 * 0 below every threshold, for an unparseable stamp, or a future one.
 */
export function requestAgeLevel(
  iso: string,
  now: Date,
  thresholdDays: readonly number[],
): RequestAgeLevel {
  const age = ageOf(iso, now);
  if (Number.isNaN(age) || age < 0) return 0;
  let level: RequestAgeLevel = 0;
  thresholdDays.forEach((days, i) => {
    if (age >= days * DAY) level = (i + 1) as RequestAgeLevel;
  });
  return level;
}

/** The color for each level: faint, then yellow, orange, red. */
export const REQUEST_AGE_COLORS = [
  "var(--fg-faint)",
  "var(--age-1)",
  "var(--age-2)",
  "var(--age-3)",
] as const;

/** "directly" or "via team <slug>". */
export function reviewRequestVia(via: string): string {
  return via.startsWith("team:") ? `via team ${via.slice("team:".length)}` : "directly";
}

/** Tooltip: exact local time, who asked, and whether directly or via a team. */
export function reviewRequestTooltip(request: ReviewRequest): string {
  const when = formatFullTimestamp(request.at);
  const who = request.by ? ` by ${request.by}` : "";
  return `Review requested ${when}${who}, ${reviewRequestVia(request.via)}`;
}

/**
 * The request worth showing, if any: nothing when none is pending (or it was
 * never looked up), and nothing on a merged/closed PR, where nobody is
 * waiting on a review any more.
 */
export function visibleReviewRequest(
  request: ReviewRequest | null | undefined,
  state: PrGithubState | null | undefined,
): ReviewRequest | null {
  if (!request) return null;
  if (state === "merged" || state === "closed") return null;
  return Number.isNaN(new Date(request.at).getTime()) ? null : request;
}
