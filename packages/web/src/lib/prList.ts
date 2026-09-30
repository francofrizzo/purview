/**
 * Pure view-model helpers for the home screen: how an `addedAt` stamp reads,
 * and how a flat `GET /api/prs` list becomes the per-repo groups the list
 * renders. Kept out of the component so both are unit-testable.
 */

import type { PrListEntry } from "../api/types";
import { visibleReviewRequest } from "./reviewRequest";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Past this, a relative stamp stops being easier to read than a date. */
export const RELATIVE_CUTOFF_MS = 7 * DAY;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * `Aug 3` for this year, `Aug 3, 2025` for any other — spelled out rather than
 * delegated to `toLocaleDateString` so the same input always renders the same
 * string, whatever locale the browser (or the test runner) is in.
 */
export function formatAbsoluteDate(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const stem = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? stem : `${stem}, ${d.getFullYear()}`;
}

/**
 * Relative under a week ("2d ago"), an absolute date beyond it. A stamp in the
 * future (clock skew between the server and the browser) reads as "just now"
 * rather than as a negative age.
 */
export function formatAddedAt(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const age = now.getTime() - d.getTime();
  if (age >= RELATIVE_CUTOFF_MS) return formatAbsoluteDate(iso, now);
  if (age < MINUTE) return "just now";
  if (age < HOUR) return `${Math.floor(age / MINUTE)}m ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)}h ago`;
  return `${Math.floor(age / DAY)}d ago`;
}

/** Full timestamp for the row's tooltip. Locale-formatted: it is never asserted on. */
export function formatFullTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * A must-read line count for the effort badge's tooltip: exact under 1000,
 * abbreviated to one decimal ("1.6k") at and above it — the tooltip states a
 * ballpark, not an audit trail.
 */
export function formatMustReadLines(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

/* ------------------------------------------------------------- grouping */

export interface RepoGroup {
  /** `host/owner/repo` — also the `:rkey` the repo routes take. */
  key: string;
  host: string;
  owner: string;
  repo: string;
  /** unarchived PRs with a pending request for your review, longest-waiting first */
  needsReview: PrListEntry[];
  /** unarchived PRs you opened, most recently added first */
  mine: PrListEntry[];
  /** the other unarchived PRs, most recently added first */
  prs: PrListEntry[];
  /** archived PRs, most recently added first */
  archived: PrListEntry[];
  /** the newest `addedAt` in the group, archived rows included */
  latestAddedAt: string;
  /** the whole repo is archived: the group lives under "archived repos" */
  repoArchived: boolean;
}

const time = (iso: string | undefined) => {
  const t = new Date(iso ?? "").getTime();
  return Number.isNaN(t) ? 0 : t;
};

const byAddedAtDesc = (a: PrListEntry, b: PrListEntry) => time(b.addedAt) - time(a.addedAt);

export const groupKeyOf = (pr: PrListEntry): string =>
  `${pr.meta?.host ?? "github.com"}/${pr.meta?.owner ?? "?"}/${pr.meta?.repo ?? "?"}`;

const needsReviewOf = (pr: PrListEntry) =>
  !pr.archived && visibleReviewRequest(pr.reviewRequest, pr.state) !== null;

const bucketOf = (group: RepoGroup, pr: PrListEntry): PrListEntry[] => {
  if (pr.archived) return group.archived;
  if (needsReviewOf(pr)) return group.needsReview;
  return pr.authoredByYou ? group.mine : group.prs;
};

const byRequestAtAsc = (a: PrListEntry, b: PrListEntry) =>
  time(a.reviewRequest?.at) - time(b.reviewRequest?.at) || byAddedAtDesc(a, b);

/**
 * One group per repo. Unarchived PRs still waiting on your review lead the
 * group, longest-waiting first; then the ones you opened, then the rest, both
 * newest-added first. Repos with
 * such a request come before repos without one; within each tier, the repo
 * with the newest PR floats to the top. Ties fall back to the group key so the
 * order is total (and stable in tests).
 */
export function groupPrsByRepo(prs: PrListEntry[]): RepoGroup[] {
  const groups = new Map<string, RepoGroup>();
  for (const pr of prs) {
    const key = groupKeyOf(pr);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        host: pr.meta?.host ?? "github.com",
        owner: pr.meta?.owner ?? "?",
        repo: pr.meta?.repo ?? "?",
        needsReview: [],
        mine: [],
        prs: [],
        archived: [],
        latestAddedAt: pr.addedAt,
        repoArchived: false,
      };
      groups.set(key, group);
    }
    bucketOf(group, pr).push(pr);
    if (pr.repoArchived) group.repoArchived = true;
    if (time(pr.addedAt) > time(group.latestAddedAt)) group.latestAddedAt = pr.addedAt;
  }
  const out = [...groups.values()];
  for (const g of out) {
    g.needsReview.sort(byRequestAtAsc);
    g.mine.sort(byAddedAtDesc);
    g.prs.sort(byAddedAtDesc);
    g.archived.sort(byAddedAtDesc);
  }
  out.sort(
    (a, b) =>
      Number(b.needsReview.length > 0) - Number(a.needsReview.length > 0) ||
      time(b.latestAddedAt) - time(a.latestAddedAt) ||
      a.key.localeCompare(b.key),
  );
  return out;
}

/**
 * The optimistic counterpart of `POST /api/prs/:key/archive`: flip one row's
 * flag in a list that is otherwise left alone. Regrouping is derived, so the
 * row moves into (or out of) the disclosure on its own.
 */
export function applyArchive(
  prs: PrListEntry[],
  key: string,
  archived: boolean,
): PrListEntry[] {
  return prs.map((p) => (p.key === key ? { ...p, archived } : p));
}

/**
 * The list's two tiers: repos in use, in `groupPrsByRepo`'s order, and whole
 * archived repos, which go into the collapsed "archived repos" disclosure at
 * the bottom (same order among themselves).
 */
export function partitionRepoGroups(groups: RepoGroup[]): {
  active: RepoGroup[];
  archived: RepoGroup[];
} {
  return {
    active: groups.filter((g) => !g.repoArchived),
    archived: groups.filter((g) => g.repoArchived),
  };
}

/**
 * The optimistic counterpart of `POST /api/repos/:rkey/archive`: flip the
 * repo flag on every row of that repo, leaving each row's own `archived`
 * exactly as it was — which is what makes unarchiving the repo a true undo.
 */
export function applyRepoArchive(
  prs: PrListEntry[],
  rkey: string,
  archived: boolean,
): PrListEntry[] {
  return prs.map((p) => (groupKeyOf(p) === rkey ? { ...p, repoArchived: archived } : p));
}

/**
 * A PR URL from what someone typed into a repo's "add by number" box:
 * `123` or `#123` (surrounding space ignored). Null for anything else.
 */
export function prUrlForNumber(
  repo: { host: string; owner: string; repo: string },
  input: string,
): string | null {
  const m = /^#?(\d+)$/.exec(input.trim());
  if (!m || Number(m[1]) < 1) return null;
  return `https://${repo.host}/${repo.owner}/${repo.repo}/pull/${Number(m[1])}`;
}
