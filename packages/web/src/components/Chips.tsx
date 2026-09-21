import type {
  Attention,
  EffortBadge,
  Kind,
  PrGithubState,
  ReviewDecision,
  ReviewEffort,
  ReviewRequest,
  RiskFlag,
} from "../api/types";
import { Link } from "react-router-dom";
import { formatMustReadLines } from "../lib/prList";
import {
  formatRequestedAgo,
  isReviewRequestOverdue,
  reviewRequestTooltip,
  visibleReviewRequest,
} from "../lib/reviewRequest";
import { useNow } from "../lib/useNow";
import type { StackedOnLink } from "../lib/stacked";
import { IconBolt, IconCheck, IconWeight, RISK_META } from "./icons";

// Colors come from the active theme (see src/lib/themes.ts), so the chips stay
// distinguishable — and coherent with the syntax colors — on every theme.
const KIND_STYLE: Record<Kind, { label: string; color: string; bg: string }> = {
  "core-logic": { label: "core", color: "var(--kind-core)", bg: "var(--kind-core-soft)" },
  "connective-tissue": { label: "glue", color: "var(--kind-glue)", bg: "var(--kind-glue-soft)" },
  wiring: { label: "wiring", color: "var(--kind-wiring)", bg: "var(--kind-wiring-soft)" },
  ripple: { label: "ripple", color: "var(--kind-ripple)", bg: "var(--kind-ripple-soft)" },
  tests: { label: "tests", color: "var(--kind-tests)", bg: "var(--kind-tests-soft)" },
  docs: { label: "docs", color: "var(--kind-docs)", bg: "var(--kind-docs-soft)" },
};

const ATTENTION_STYLE: Record<Attention, { label: string; color: string; bg: string }> = {
  "must-read": { label: "must-read", color: "var(--risk)", bg: "var(--risk-soft)" },
  skim: { label: "skim", color: "var(--warn)", bg: "var(--warn-soft)" },
  skip: { label: "skip", color: "var(--kind-wiring)", bg: "var(--kind-wiring-soft)" },
};

/**
 * GitHub's own lifecycle state. The hues are the conventional ones (green /
 * gray / purple / red) but every one of them is a theme token, so the chips
 * track the active theme's palette instead of pinning GitHub's brand colors.
 */
const PR_STATE_STYLE: Record<PrGithubState, { label: string; color: string; bg: string }> = {
  open: { label: "open", color: "var(--ok)", bg: "var(--ok-soft)" },
  draft: { label: "draft", color: "var(--kind-wiring)", bg: "var(--kind-wiring-soft)" },
  merged: { label: "merged", color: "var(--kind-core)", bg: "var(--kind-core-soft)" },
  closed: { label: "closed", color: "var(--risk)", bg: "var(--risk-soft)" },
};

export function PrStateChip({ state }: { state: PrGithubState }) {
  const s = PR_STATE_STYLE[state] ?? PR_STATE_STYLE.open;
  return (
    <span className="chip" style={{ color: s.color, background: s.bg }} title={`GitHub state: ${state}`}>
      {s.label}
    </span>
  );
}

const DECISION_STYLE: Record<
  ReviewDecision,
  { label: string; check?: boolean; color: string; title: string }
> = {
  approved: { label: "approved", check: true, color: "var(--ok)", title: "Approved on GitHub" },
  changes_requested: {
    label: "changes requested",
    color: "var(--warn)",
    title: "Changes requested on GitHub",
  },
  review_required: {
    label: "review required",
    color: "var(--fg-faint)",
    title: "GitHub is still waiting for a required review",
  },
};

/**
 * Deliberately quieter than the state chip: text-only, no fill, so it reads as
 * a qualifier on the state rather than as a second status of equal weight.
 */
export function ReviewDecisionChip({ decision }: { decision: ReviewDecision | null }) {
  if (!decision) return null;
  const s = DECISION_STYLE[decision];
  if (!s) return null;
  return (
    <span
      className="chip px-0 font-normal"
      style={{ color: s.color, background: "transparent" }}
      title={s.title}
    >
      {s.label}
      {s.check ? <IconCheck width={10} height={10} /> : null}
    </span>
  );
}

/**
 * "requested 3d ago" — how long the user's review has been waited on. Plain
 * faint text, not a chip: it is context. It turns the warning color once the
 * request is three days old, and re-renders every minute so the age stays
 * right on a page left open. Renders nothing when no request is pending.
 */
export function ReviewRequestAge({
  request,
  state,
  className,
}: {
  request: ReviewRequest | null | undefined;
  state?: PrGithubState | null;
  className?: string;
}) {
  const now = useNow();
  const shown = visibleReviewRequest(request, state);
  if (!shown) return null;
  const at = new Date(now);
  return (
    <span
      className={className}
      style={{ color: isReviewRequestOverdue(shown.at, at) ? "var(--warn)" : "var(--fg-faint)" }}
      title={reviewRequestTooltip(shown)}
      data-testid="review-request-age"
    >
      {formatRequestedAgo(shown.at, at)}
    </span>
  );
}

/**
 * "stacked on #n" in the PR header. Quiet on purpose — neutral colors, like a
 * qualifier on the title — since it is context, not a status.
 */
export function StackedOnChip({ link }: { link: StackedOnLink | null }) {
  if (!link) return null;
  const cls = "chip flex-none self-center hover:underline";
  const style = { color: "var(--fg-faint)", background: "var(--bg-inset)" };
  return link.internal ? (
    <Link to={link.href} className={cls} style={style} title={link.title} data-testid="stacked-on-chip">
      {link.label}
    </Link>
  ) : (
    <a
      href={link.href}
      target="_blank"
      rel="noreferrer"
      className={cls}
      style={style}
      title={link.title}
      data-testid="stacked-on-chip"
    >
      {link.label}
    </a>
  );
}

export function KindChip({ kind }: { kind: Kind }) {
  const s = KIND_STYLE[kind] ?? KIND_STYLE.wiring;
  return (
    <span className="chip" style={{ color: s.color, background: s.bg }} title={kind}>
      {s.label}
    </span>
  );
}

export function AttentionChip({ attention }: { attention: Attention }) {
  const s = ATTENTION_STYLE[attention] ?? ATTENTION_STYLE.skim;
  return (
    <span className="chip" style={{ color: s.color, background: s.bg }}>
      {s.label}
    </span>
  );
}

/** Just the color decision behind {@link AttentionChip}, for callers (e.g. a
 *  hunk header's unit dot) that want the same hue without the whole chip. */
export function attentionColor(attention: Attention): string {
  return (ATTENTION_STYLE[attention] ?? ATTENTION_STYLE.skim).color;
}

/** The soft background half of the same decision, for callers building their
 *  own tinted chip-alike (e.g. the collapsed sidebar rail's unit squares). */
export function attentionSoftBg(attention: Attention): string {
  return (ATTENTION_STYLE[attention] ?? ATTENTION_STYLE.skim).bg;
}

const EFFORT_STYLE: Record<
  Exclude<EffortBadge, null>,
  { label: string; icon: (p: { width?: number; height?: number }) => JSX.Element; color: string; bg: string }
> = {
  fast: { label: "fast", icon: IconBolt, color: "var(--ok)", bg: "var(--ok-soft)" },
  heavy: { label: "heavy", icon: IconWeight, color: "var(--warn)", bg: "var(--warn-soft)" },
};

/**
 * The PR list's effort badge — "fast" (small, low-risk must-read surface) or
 * "heavy" (large or risky). Renders nothing for the unbadged middle (most
 * PRs) and for PRs without an analysis: an absent chip says nothing, where a
 * placeholder would read as "checked, found nothing".
 */
export function EffortChip({ effort }: { effort?: ReviewEffort | null }) {
  if (!effort?.badge) return null;
  const s = EFFORT_STYLE[effort.badge];
  const Icon = s.icon;
  const lines = formatMustReadLines(effort.weightedMustReadLines);
  const flags = effort.riskCount === 1 ? "flag" : "flags";
  return (
    <span
      className="chip"
      data-testid="effort-chip"
      title={`~${lines} must-read lines · ${effort.riskCount} risk ${flags}`}
      style={{ color: s.color, background: s.bg }}
    >
      <Icon width={10} height={10} />
      {s.label}
    </span>
  );
}

/**
 * One quiet chip for a unit's whole risk surface, instead of a row of
 * per-flag icons: the icons read as alarms and needed a hover each to decode.
 * The full variant names the flags; `compact` (sidebar rows) shows a count
 * and leaves the names to the tooltip.
 */
export function RiskFlags({ flags, compact }: { flags: RiskFlag[]; compact?: boolean }) {
  if (!flags?.length) return null;
  const labels = flags.map((f) => RISK_META[f]?.label ?? f);
  const one = labels.length === 1;
  return (
    <span
      className="chip"
      data-testid="risk-chip"
      title={`Risk surface${one ? "" : "s"}: ${labels.join(", ")}`}
      style={{ color: "var(--risk)", background: "var(--risk-soft)" }}
    >
      {compact
        ? `${labels.length} risk${one ? "" : "s"}`
        : `risk${one ? "" : "s"}: ${labels.join(" + ")}`}
    </span>
  );
}

export function ChangedBadge({ count, onClick }: { count?: number; onClick?: () => void }) {
  const content = count && count > 1 ? `changed ×${count}` : "changed";
  const cls = "chip";
  const style = { color: "var(--warn)", background: "var(--warn-soft)" };
  if (!onClick) {
    return (
      <span className={cls} style={style} title="Changed since you viewed it">
        {content}
      </span>
    );
  }
  return (
    <button type="button" className={cls} style={style} onClick={onClick}>
      {content}
    </button>
  );
}

export function Progress({ viewed, total }: { viewed: number; total: number }) {
  const pct = total ? Math.round((viewed / total) * 100) : 0;
  const done = total > 0 && viewed === total;
  return (
    <span className="inline-flex items-center gap-1.5" title={`${viewed} of ${total} hunks viewed`}>
      <span
        className="h-1 w-8 overflow-hidden rounded-full"
        style={{ background: "var(--bg-inset)" }}
      >
        <span
          className="block h-full rounded-full transition-all"
          style={{ width: `${pct}%`, background: done ? "var(--ok)" : "var(--accent)" }}
        />
      </span>
      <span
        className="text-2xs tabular-nums"
        style={{ color: done ? "var(--ok)" : "var(--fg-faint)" }}
      >
        {viewed}/{total}
      </span>
    </span>
  );
}
