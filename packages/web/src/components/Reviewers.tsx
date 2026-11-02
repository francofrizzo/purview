import { useEffect, useRef, useState } from "react";
import type { PrGithubState, Reviewer, ReviewerCandidate } from "../api/types";
import { errorText } from "../api/errors";
import { useReviewerCandidates, useReviewRequests } from "../api/hooks";
import { AuthorAvatar } from "./AuthorAvatar";
import { FloatingPanel } from "./FloatingPanel";
import { IconCheck, IconClock, IconClose, IconRefresh, IconWarning } from "./icons";

/** How many avatars the cluster shows before folding the rest into "+N". */
const MAX_SHOWN = 4;

const STATE_LABEL: Record<Reviewer["state"], string> = {
  requested: "requested",
  approved: "approved",
  changes_requested: "changes requested",
  commented: "commented",
  dismissed: "dismissed",
};

/**
 * The badge on an avatar: a clock while the reviewer is still to answer, a
 * check or a cross once they did. Solid discs (the soft tints are translucent
 * and vanish over an avatar): verdicts in their color with the glyph in the
 * pane color, the clock quiet on the inset surface.
 */
const BADGE: Partial<Record<Reviewer["state"], { fg: string; bg: string }>> = {
  requested: { fg: "var(--fg-muted)", bg: "var(--bg-inset)" },
  approved: { fg: "var(--bg)", bg: "var(--ok)" },
  changes_requested: { fg: "var(--bg)", bg: "var(--risk)" },
};

/** Only an open PR of yours has reviewers worth watching. */
export function showsReviewers(authoredByYou: boolean | undefined, state: PrGithubState | undefined): boolean {
  return authoredByYou === true && (state === "open" || state === "draft" || state === undefined);
}

/** The people on the PR: a bot's review (CodeRabbit, Copilot…) does not make it a reviewer. */
export function humanReviewers(reviewers: Reviewer[]): Reviewer[] {
  return reviewers.filter((r) => !r.bot);
}

export function reviewersTooltip(reviewers: Reviewer[]): string {
  return reviewers.map((r) => `${r.login} · ${STATE_LABEL[r.state]}`).join("\n");
}

/**
 * Who is on one of your PRs, at a glance: up to four overlapping avatars, a
 * reviewer still to answer dimmed with a clock, one who did with a check or a
 * cross; "+N" for the rest. Bots are left out. Fetched and nobody human says
 * "no reviewers"; not fetched yet renders nothing. The PR page's own verdict
 * strip (Reviews.tsx) is a different thing: that one reads the review
 * timeline, this one GitHub's reviewer list.
 */
export function ReviewersMark({
  reviewers,
  className,
  ring = "var(--bg)",
}: {
  reviewers: Reviewer[] | undefined;
  className?: string;
  /** The pane the cluster sits on: the gap between overlapping discs is painted in it. */
  ring?: string;
}) {
  if (reviewers === undefined) return null;
  const people = humanReviewers(reviewers);
  if (people.length === 0) {
    return (
      <span
        className={`chip px-0 font-normal ${className ?? ""}`}
        style={{ color: "var(--warn)", background: "transparent" }}
        data-tip="Nobody has been asked to review this PR"
        data-testid="no-reviewers"
      >
        <IconWarning width={10} height={10} />
        no reviewers
      </span>
    );
  }
  const shown = people.slice(0, MAX_SHOWN);
  const rest = people.length - shown.length;
  return (
    <span
      className={`inline-flex flex-none items-center ${className ?? ""}`}
      data-tip={reviewersTooltip(people)}
      data-testid="reviewers"
    >
      {shown.map((r, i) => {
        const badge = BADGE[r.state];
        return (
          <span
            key={r.login}
            className="relative inline-flex flex-none rounded-full"
            // The ring is the pane color so overlapping discs stay apart.
            style={{ marginLeft: i ? -4 : 0, boxShadow: `0 0 0 1.5px ${ring}` }}
            data-testid="reviewer"
            data-state={r.state}
            data-login={r.login}
          >
            <span className="inline-flex" style={{ opacity: r.state === "requested" ? 0.55 : 1 }}>
              <AuthorAvatar author={r.login} url={r.avatarUrl ?? undefined} size={16} />
            </span>
            {badge ? (
              <span
                aria-hidden
                className="absolute -bottom-[2px] -right-[3px] inline-flex h-[10px] w-[10px] items-center justify-center rounded-full"
                style={{ background: badge.bg, color: badge.fg, boxShadow: `0 0 0 1px ${ring}` }}
              >
                {r.state === "requested" ? (
                  <IconClock width={8} height={8} strokeWidth={3} />
                ) : r.state === "approved" ? (
                  <IconCheck width={9} height={9} strokeWidth={3} />
                ) : (
                  <IconClose width={8} height={8} strokeWidth={3} />
                )}
              </span>
            ) : null}
          </span>
        );
      })}
      {rest > 0 ? (
        <span className="ml-1 text-2xs tabular-nums" style={{ color: "var(--fg-faint)" }} data-testid="reviewers-more">
          +{rest}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The cluster on your own PR, as a button: it opens who is on the PR (ask
 * again, or stop asking) and a search to ask someone new, GitHub's
 * suggestions first.
 */
export function ReviewersButton({
  prKey,
  reviewers,
  className,
  ring,
}: {
  prKey: string;
  reviewers: Reviewer[] | undefined;
  className?: string;
  ring?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`inline-flex flex-none items-center rounded px-0.5 transition-colors hover:bg-[var(--bg-hover)] ${className ?? ""}`}
        style={open ? { background: "var(--bg-hover)" } : undefined}
        aria-expanded={open}
        aria-label="Reviewers"
        data-testid="reviewers-button"
        onClick={() => setOpen((v) => !v)}
      >
        {reviewers === undefined ? (
          <span className="text-2xs" style={{ color: "var(--fg-muted)" }}>
            reviewers
          </span>
        ) : (
          <ReviewersMark reviewers={reviewers} ring={ring} />
        )}
      </button>
      {open ? (
        <FloatingPanel anchorRef={ref} onClose={() => setOpen(false)} label="Reviewers" className="w-72 p-2 text-xs">
          <ReviewersPanel prKey={prKey} reviewers={reviewers ?? []} />
        </FloatingPanel>
      ) : null}
    </>
  );
}

export function ReviewersPanel({
  prKey,
  reviewers,
  autoFocus = true,
}: {
  prKey: string;
  reviewers: Reviewer[];
  /** the header's popover types at once; the review panel's section waits for a click */
  autoFocus?: boolean;
}) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  // Each keystroke would be a GitHub search: wait for a pause.
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);
  const candidates = useReviewerCandidates(prKey, query, true);
  const requests = useReviewRequests(prKey);
  const people = humanReviewers(reviewers);
  const ask = (who: { login: string; kind: "user" | "team" }, remove = false) =>
    requests.mutate(who.kind === "team" ? { teams: [who.login], remove } : { users: [who.login], remove });
  const busy = requests.isPending;

  return (
    <div className="flex flex-col gap-2 text-xs" data-testid="reviewers-panel">
      {people.length ? (
        <ul className="flex flex-col">
          {people.map((r) => (
            <li key={`${r.kind}:${r.login}`} className="flex items-center gap-2 rounded px-1.5 py-1" data-testid="reviewers-row">
              <AuthorAvatar author={r.login} url={r.avatarUrl ?? undefined} size={16} />
              <span className="min-w-0 flex-1 truncate" style={{ color: "var(--fg)" }}>
                {r.login}
              </span>
              <span className="flex-none text-2xs" style={{ color: "var(--fg-faint)" }}>
                {STATE_LABEL[r.state]}
              </span>
              {r.state === "requested" ? (
                <button
                  type="button"
                  disabled={busy}
                  className="flex-none rounded p-0.5 hover:bg-[var(--bg-hover)] hover:!text-[var(--fg)] disabled:opacity-50"
                  style={{ color: "var(--fg-faint)" }}
                  data-tip={`Stop asking ${r.login}`}
                  aria-label={`Stop asking ${r.login}`}
                  data-testid={`reviewers-remove-${r.login}`}
                  onClick={() => ask(r, true)}
                >
                  <IconClose width={10} height={10} />
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  className="flex-none rounded p-0.5 hover:bg-[var(--bg-hover)] hover:!text-[var(--fg)] disabled:opacity-50"
                  style={{ color: "var(--fg-faint)" }}
                  data-tip={`Ask ${r.login} to review again`}
                  aria-label={`Ask ${r.login} to review again`}
                  data-testid={`reviewers-rerequest-${r.login}`}
                  onClick={() => ask(r)}
                >
                  <IconRefresh width={11} height={11} />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <input
        autoFocus={autoFocus}
        className="input text-xs"
        placeholder="Ask someone to review…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        data-testid="reviewers-search"
      />
      <ul className="flex max-h-60 flex-col overflow-y-auto">
        {(candidates.data ?? []).map((c: ReviewerCandidate) => (
          <li key={`${c.kind}:${c.login}`}>
            <button
              type="button"
              disabled={busy}
              className="flex w-full min-w-0 items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-[var(--bg-hover)] disabled:opacity-50"
              data-testid={`reviewers-candidate-${c.login}`}
              data-tip={c.kind === "team" ? `Ask the ${c.name ?? c.login} team` : `Ask ${c.login}`}
              onClick={() => {
                ask(c);
                setQ("");
              }}
            >
              <AuthorAvatar author={c.login} url={c.avatarUrl ?? undefined} size={16} />
              <span className="flex-none" style={{ color: "var(--fg)" }}>
                {c.kind === "team" ? `team/${c.login}` : c.login}
              </span>
              {c.name && c.kind === "user" ? (
                <span className="min-w-0 truncate text-2xs" style={{ color: "var(--fg-faint)" }}>
                  {c.name}
                </span>
              ) : null}
              {c.suggested ? (
                <span className="ml-auto flex-none text-2xs" style={{ color: "var(--fg-faint)" }}>
                  suggested
                </span>
              ) : null}
            </button>
          </li>
        ))}
        {candidates.isFetched && !candidates.data?.length ? (
          <li className="px-1.5 py-1 text-2xs" style={{ color: "var(--fg-faint)" }}>
            {query ? "Nobody here matches" : "Type a name or a team"}
          </li>
        ) : null}
      </ul>
      {candidates.error || requests.error ? (
        <p className="px-1.5 text-2xs" style={{ color: "var(--risk)" }} data-testid="reviewers-error">
          {errorText(requests.error ?? candidates.error)}
        </p>
      ) : null}
    </div>
  );
}
