import type { PrGithubState, Reviewer } from "../api/types";
import { AuthorAvatar } from "./AuthorAvatar";
import { IconCheck, IconClose, IconWarning } from "./icons";

/** How many avatars the cluster shows before folding the rest into "+N". */
const MAX_SHOWN = 4;

const STATE_LABEL: Record<Reviewer["state"], string> = {
  requested: "requested",
  approved: "approved",
  changes_requested: "changes requested",
  commented: "commented",
  dismissed: "dismissed",
};

/** The verdict badge on an avatar: a check or a cross on its soft tint; none for the rest. */
const BADGE: Partial<Record<Reviewer["state"], { fg: string; bg: string }>> = {
  approved: { fg: "var(--ok)", bg: "var(--ok-soft)" },
  changes_requested: { fg: "var(--risk)", bg: "var(--risk-soft)" },
};

/** Only an open PR of yours has reviewers worth watching. */
export function showsReviewers(authoredByYou: boolean | undefined, state: PrGithubState | undefined): boolean {
  return authoredByYou === true && (state === "open" || state === "draft" || state === undefined);
}

export function reviewersTooltip(reviewers: Reviewer[]): string {
  return reviewers.map((r) => `${r.login} · ${STATE_LABEL[r.state]}`).join("\n");
}

/**
 * Who is on one of your PRs, at a glance: up to four overlapping avatars, a
 * dashed ring on a reviewer still to answer, a check or a cross on one who
 * did; "+N" for the rest. Fetched and empty says "no reviewers"; not fetched
 * yet renders nothing. The PR page's own verdict strip (Reviews.tsx) is a
 * different thing: that one reads the review timeline, this one GitHub's
 * reviewer list.
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
  if (reviewers.length === 0) {
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
  const shown = reviewers.slice(0, MAX_SHOWN);
  const rest = reviewers.length - shown.length;
  return (
    <span
      className={`inline-flex flex-none items-center ${className ?? ""}`}
      data-tip={reviewersTooltip(reviewers)}
      data-testid="reviewers"
    >
      {shown.map((r, i) => {
        const badge = BADGE[r.state];
        return (
          <span
            key={r.login}
            className="relative inline-flex flex-none rounded-full"
            style={{
              marginLeft: i ? -4 : 0,
              // The ring is the pane color so overlapping discs stay apart;
              // a reviewer still to answer gets a dashed one in its place.
              boxShadow: r.state === "requested" ? undefined : `0 0 0 1.5px ${ring}`,
              outline: r.state === "requested" ? "1.5px dashed var(--fg-faint)" : undefined,
              outlineOffset: 1,
            }}
            data-testid="reviewer"
            data-state={r.state}
            data-login={r.login}
          >
            <AuthorAvatar author={r.login} url={r.avatarUrl ?? undefined} size={16} />
            {badge ? (
              <span
                aria-hidden
                className="absolute -bottom-[3px] -right-[3px] inline-flex h-[10px] w-[10px] items-center justify-center rounded-full"
                style={{ background: badge.bg, color: badge.fg, boxShadow: `0 0 0 1.5px ${ring}` }}
              >
                {r.state === "approved" ? (
                  <IconCheck width={8} height={8} strokeWidth={2.4} />
                ) : (
                  <IconClose width={7} height={7} strokeWidth={2.4} />
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
