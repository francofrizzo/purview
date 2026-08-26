/**
 * Pure view-model helpers for the home screen: how an `addedAt` stamp reads,
 * and how a flat `GET /api/prs` list becomes the per-repo groups the list
 * renders. Kept out of the component so both are unit-testable.
 */

import type { PrListEntry } from "../api/types";

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

/* ------------------------------------------------------------- grouping */

export interface RepoGroup {
  /** `host/owner/repo` — also the `:rkey` the repo routes take. */
  key: string;
  host: string;
  owner: string;
  repo: string;
  /** unarchived PRs, most recently added first */
  prs: PrListEntry[];
  /** archived PRs, most recently added first */
  archived: PrListEntry[];
  /** the newest `addedAt` in the group, archived rows included */
  latestAddedAt: string;
}

const time = (iso: string | undefined) => {
  const t = new Date(iso ?? "").getTime();
  return Number.isNaN(t) ? 0 : t;
};

const byAddedAtDesc = (a: PrListEntry, b: PrListEntry) => time(b.addedAt) - time(a.addedAt);

export const groupKeyOf = (pr: PrListEntry): string =>
  `${pr.meta?.host ?? "github.com"}/${pr.meta?.owner ?? "?"}/${pr.meta?.repo ?? "?"}`;

/**
 * One group per repo, each sorted newest-added first; groups themselves are
 * ordered by their newest PR, so the repo you last touched floats to the top.
 * Ties fall back to the group key so the order is total (and stable in tests).
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
        prs: [],
        archived: [],
        latestAddedAt: pr.addedAt,
      };
      groups.set(key, group);
    }
    (pr.archived ? group.archived : group.prs).push(pr);
    if (time(pr.addedAt) > time(group.latestAddedAt)) group.latestAddedAt = pr.addedAt;
  }
  const out = [...groups.values()];
  for (const g of out) {
    g.prs.sort(byAddedAtDesc);
    g.archived.sort(byAddedAtDesc);
  }
  out.sort(
    (a, b) => time(b.latestAddedAt) - time(a.latestAddedAt) || a.key.localeCompare(b.key),
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
