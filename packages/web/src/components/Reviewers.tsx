import type { PrGithubState, Reviewer } from "../api/types";
import { AuthorAvatar } from "./AuthorAvatar";
import { IconCheck, IconClock, IconClose, IconWarning } from "./icons";

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
