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
/** A request at least this old is shown in the warning color. */
export const REVIEW_REQUEST_OVERDUE_MS = 3 * DAY;

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

/** True once the request has waited `REVIEW_REQUEST_OVERDUE_MS` or longer. */
export function isReviewRequestOverdue(iso: string, now: Date = new Date()): boolean {
  const age = ageOf(iso, now);
  return !Number.isNaN(age) && age >= REVIEW_REQUEST_OVERDUE_MS;
}

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
