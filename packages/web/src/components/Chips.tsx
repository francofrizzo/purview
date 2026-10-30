import { useCallback, useRef, useState } from "react";
import { FloatingPanel } from "./FloatingPanel";
import type {
  Attention,
  Ci,
  DiffSize,
  EffortBadge,
  FileEntry,
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
  REQUEST_AGE_COLORS,
  requestAgeLevel,
  reviewRequestTooltip,
  visibleReviewRequest,
} from "../lib/reviewRequest";
import { useSettings } from "../lib/settings";
import { useNow } from "../lib/useNow";
import type { StackedOnLink } from "../lib/stacked";
import { IconArrowDown, IconBolt, IconCheck, IconEye, IconWarning, IconWeight, RISK_META } from "./icons";

// Colors come from the active theme (see src/lib/themes.ts), so the chips stay
// distinguishable — and coherent with the syntax colors — on every theme.
const KIND_STYLE: Record<Kind, { label: string; color: string; bg: string; tip: string }> = {
  "core-logic": {
    label: "core",
    color: "var(--kind-core)",
    bg: "var(--kind-core-soft)",
    tip: "Core logic: what the system decides or does. Wrong here means wrong behavior.",
  },
  "connective-tissue": {
    label: "glue",
    color: "var(--kind-glue)",
    bg: "var(--kind-glue-soft)",
    tip: "Connective tissue: glue that makes a small decision while connecting two things, like a mapper with a branch or an adapter.",
  },
  refactor: {
    label: "refactor",
    color: "var(--kind-refactor)",
    bg: "var(--kind-refactor-soft)",
    tip: "Refactor: restructured with nothing changed, like a move, an extraction or a rename. Confirm the behavior is the same.",
  },
  data: {
    label: "data",
    color: "var(--kind-data)",
    bg: "var(--kind-data-soft)",
    tip: "Data: schema and migrations, seeds, generated files and lockfiles. Verify against the source rather than trace logic.",
  },
  wiring: {
    label: "wiring",
    color: "var(--kind-wiring)",
    bg: "var(--kind-wiring-soft)",
    tip: "Wiring: mechanical connection with no decisions, like registrations, exports and config values.",
  },
  ripple: {
    label: "ripple",
    color: "var(--kind-ripple)",
    bg: "var(--kind-ripple-soft)",
    tip: "Ripple: fallout of another change in this PR, like renamed call sites, a parameter threaded through or moved imports.",
  },
  tests: { label: "tests", color: "var(--kind-tests)", bg: "var(--kind-tests-soft)", tip: "Tests, fixtures and evals." },
  docs: { label: "docs", color: "var(--kind-docs)", bg: "var(--kind-docs-soft)", tip: "Docs and comment-only changes." },
};

const ATTENTION_STYLE: Record<
  Attention,
  { label: string; color: string; bg: string; icon: (p: { width: number; height: number }) => JSX.Element; tip: string }
> = {
  "must-read": {
    label: "must-read",
    color: "var(--risk)",
    bg: "var(--risk-soft)",
    icon: IconWarning,
    tip: "Must-read: getting this wrong breaks something, or it encodes a decision you have to validate.",
  },
  skim: {
    label: "skim",
    color: "var(--warn)",
    bg: "var(--warn-soft)",
    icon: IconEye,
    tip: "Skim: check the shape is right without tracing the logic.",
  },
  skip: {
    label: "skip",
    color: "var(--kind-wiring)",
    bg: "var(--kind-wiring-soft)",
    icon: IconArrowDown,
    tip: "Skip: mechanical and correct by construction.",
  },
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
    <span className="chip" style={{ color: s.color, background: s.bg }} data-tip={`GitHub state: ${state}`}>
      {s.label}
    </span>
  );
}

function ciSummary(ci: Ci) {
  const token = ci.state === "success" ? "ok" : ci.state === "failure" ? "risk" : "warn";
  const label = ci.state === "success" ? "passing" : ci.state === "failure" ? "failing" : "pending";
  const count = ci.checks.filter((c) => c.state === ci.state).length;
  const mixed = new Set(ci.checks.map((c) => c.state)).size > 1;
  const Icon = ci.state === "success" ? IconCheck : ci.state === "failure" ? IconWarning : IconBolt;
  return { token, label, count, mixed, Icon, firstFailure: ci.checks.find((c) => c.state === "failure")?.name };
}

/**
 * CI beside the line counts: the icon in the state's color, the count only
 * when the checks disagree, the words in the tip. Interactive, it opens the
 * list of checks with a link to each run.
 */
export function CiMark({ ci, interactive = false }: { ci?: Ci; interactive?: boolean }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  if (!ci || ci.state === "none") return null;
  const { token, label, count, mixed, Icon, firstFailure } = ciSummary(ci);
  const tip = `CI ${label}${mixed ? ` (${count} of ${ci.checks.length})` : ""}${firstFailure ? `: ${firstFailure}` : ""}`;
  const props = {
    className: "inline-flex flex-none items-center gap-0.5 text-2xs tabular-nums",
    style: { color: `var(--${token})` },
    "data-tip": tip,
    "data-testid": "ci-mark",
  };
  const content = <><Icon width={10} height={10} />{mixed ? `${count}/${ci.checks.length}` : null}</>;
  if (!interactive) return <span {...props}>{content}</span>;
  return (
    <span ref={anchorRef} className="inline-flex flex-none">
      <button {...props} type="button" aria-label={tip} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((v) => !v)}>
        {content}
      </button>
      {open ? (
        <FloatingPanel anchorRef={anchorRef} onClose={close} label="CI checks" className="w-80 max-h-80 overflow-y-auto p-3 text-xs">
          <ul className="space-y-2" style={{ color: "var(--fg)" }}>
            {ci.checks.map((check, i) => (
              <li key={i} data-testid="ci-check" className="flex items-start justify-between gap-3">
                {check.url ? <a className="underline break-words" href={check.url} target="_blank" rel="noreferrer">{check.name}</a> : <span>{check.name}</span>}
                <span className="flex-none">{check.state}</span>
              </li>
            ))}
          </ul>
        </FloatingPanel>
      ) : null}
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
  // Not "review requested": this is the PR's merge gate, not a request of the
  // reader. Whether *you* were asked is ReviewRequestAge's "asked you 3d ago".
  review_required: {
    label: "awaiting approval",
    color: "var(--fg-faint)",
    title: "GitHub still needs an approving review before this can merge (from anyone, not necessarily you)",
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
      data-tip={s.title}
    >
      {s.label}
      {s.check ? <IconCheck width={10} height={10} /> : null}
    </span>
  );
}

/**
 * "asked you 3d ago" — how long the user's review has been waited on. Plain
 * faint text, not a chip: it is context. It warms from yellow to orange to red
 * as it crosses the thresholds in Settings, and re-renders every minute so the
 * age stays right on a page left open. Renders nothing when no request is pending.
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
  const { settings } = useSettings();
  const shown = visibleReviewRequest(request, state);
  if (!shown) return null;
  const at = new Date(now);
  return (
    <span
      className={className}
      style={{ color: REQUEST_AGE_COLORS[requestAgeLevel(shown.at, at, settings.requestAgeDays)] }}
      data-tip={reviewRequestTooltip(shown)}
      data-testid="review-request-age"
    >
      {formatRequestedAgo(shown.at, at, shown.via)}
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
    <Link to={link.href} className={cls} style={style} data-tip={link.title} data-testid="stacked-on-chip">
      {link.label}
    </Link>
  ) : (
    <a
      href={link.href}
      target="_blank"
      rel="noreferrer"
      className={cls}
      style={style}
      data-tip={link.title}
      data-testid="stacked-on-chip"
    >
      {link.label}
    </a>
  );
}

export function KindChip({ kind }: { kind: Kind }) {
  const s = KIND_STYLE[kind] ?? KIND_STYLE.wiring;
  return (
    <span className="chip" style={{ color: s.color, background: s.bg }} data-tip={s.tip}>
      {s.label}
    </span>
  );
}

export function AttentionChip({ attention }: { attention: Attention }) {
  const s = ATTENTION_STYLE[attention] ?? ATTENTION_STYLE.skim;
  return (
    <span className="chip" style={{ color: s.color, background: s.bg }} data-attention={attention} data-tip={s.tip}>
      <s.icon width={10} height={10} />
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
      data-tip={`~${lines} must-read lines · ${effort.riskCount} risk ${flags}`}
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
      data-tip={`Risk surface${one ? "" : "s"}: ${labels.join(", ")}`}
      style={{ color: "var(--risk)", background: "var(--risk-soft)" }}
    >
      {compact
        ? `${labels.length} risk${one ? "" : "s"}`
        : `risk${one ? "" : "s"}: ${labels.join(" + ")}`}
    </span>
  );
}

export function ChangedBadge({ tip, testId, onClick }: { tip?: string; testId?: string; onClick?: () => void }) {
  const content = "changed";
  const cls = "chip";
  const style = { color: "var(--warn)", background: "var(--warn-soft)" };
  if (!onClick) {
    return (
      <span className={cls} style={style} data-testid={testId} data-tip={tip ?? "Changed since you viewed it"}>
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

/**
 * `Progress` once anything is viewed; before that, just the size ("12 hunks"),
 * so an untouched list is not a column of empty bars.
 */
export function HunkProgress({ viewed, total }: { viewed: number; total: number }) {
  if (viewed > 0) return <Progress viewed={viewed} total={total} />;
  return (
    <span
      className="text-2xs tabular-nums"
      style={{ color: "var(--fg-faint)" }}
      data-tip={`0 of ${total} hunks viewed`}
    >
      {total} {total === 1 ? "hunk" : "hunks"}
    </span>
  );
}

/**
 * How far through the hunks: a bar and the count. Inline (bar then count) in
 * the brief and the sidebar; `stacked` puts the count under a wider bar, for
 * the home list where the row's right edge lines up on it.
 */
export function Progress({ viewed, total, stacked = false }: { viewed: number; total: number; stacked?: boolean }) {
  const pct = total ? Math.round((viewed / total) * 100) : 0;
  const done = total > 0 && viewed === total;
  return (
    <span
      className={stacked ? "inline-flex flex-col items-end gap-0.5" : "inline-flex items-center gap-1.5"}
      data-tip={`${viewed} of ${total} hunks viewed`}
      data-testid="hunk-progress"
    >
      <span
        className={`h-1 overflow-hidden rounded-full ${stacked ? "w-14" : "w-8"}`}
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

/**
 * How far through the hunks, as a ring and the count: the home list's right
 * edge. The tooltip carries the rest (units, effort) the row no longer spells out.
 */
export function ProgressRing({ viewed, total, tip }: { viewed: number; total: number; tip?: string }) {
  const done = total > 0 && viewed === total;
  const r = 6;
  const c = 2 * Math.PI * r;
  const frac = total ? viewed / total : 0;
  return (
    <span
      className="inline-flex items-center gap-1.5"
      data-tip={tip ?? `${viewed} of ${total} hunks viewed`}
      data-testid="hunk-progress"
    >
      <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden className="flex-none -rotate-90">
        <circle cx={8} cy={8} r={r} fill="none" stroke="var(--border-strong)" strokeWidth={2} />
        {frac > 0 ? (
          <circle
            cx={8}
            cy={8}
            r={r}
            fill="none"
            stroke={done ? "var(--ok)" : "var(--accent)"}
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray={`${c * frac} ${c}`}
          />
        ) : null}
      </svg>
      <span className="min-w-9 text-right text-2xs tabular-nums" style={{ color: done ? "var(--ok)" : "var(--fg-faint)" }}>
        {viewed}/{total}
      </span>
    </span>
  );
}

/**
 * "9 files · +120 −34", GitHub's own size stat: in the PR header, and on the
 * list row without the file count. Added green, removed red, like the diff;
 * nothing at all when there are no files yet.
 */
export function DiffSizeStat({ size, files = true }: { size: DiffSize | null | undefined; files?: boolean }) {
  if (!size || size.files === 0) return null;
  const { files: n, additions, deletions } = size;
  return (
    <span
      className="inline-flex flex-none items-center gap-1 text-2xs tabular-nums"
      data-testid="diff-size"
      data-tip={`${n} ${n === 1 ? "file" : "files"} changed: ${additions} ${additions === 1 ? "line" : "lines"} added, ${deletions} removed`}
    >
      {files ? (
        <span>
          {n} {n === 1 ? "file" : "files"}
        </span>
      ) : null}
      <span style={{ color: "var(--ok)" }}>+{additions}</span>
      <span style={{ color: "var(--risk)" }}>−{deletions}</span>
    </span>
  );
}

const FILE_STATUS: Record<NonNullable<FileEntry["status"]>, { letter: string; word: string; color: string }> = {
  added: { letter: "A", word: "Added", color: "var(--ok)" },
  modified: { letter: "M", word: "Modified", color: "var(--fg-muted)" },
  removed: { letter: "D", word: "Deleted", color: "var(--risk)" },
  renamed: { letter: "R", word: "Renamed", color: "var(--accent)" },
};

/** What the PR did to a file, as a letter: color alone would not say it to everyone. */
export function FileStatusBadge({ status, tip }: { status?: FileEntry["status"]; tip?: string }) {
  if (!status) return null;
  const { letter, word, color } = FILE_STATUS[status];
  return (
    <span
      className="inline-flex h-3.5 w-3.5 flex-none items-center justify-center self-center rounded-sm font-mono text-[10px] font-semibold leading-none"
      style={{ color, boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 45%, transparent)` }}
      data-testid="file-status"
      data-status={status}
      data-tip={tip ?? word}
      aria-label={tip ?? word}
    >
      {letter}
    </span>
  );
}
