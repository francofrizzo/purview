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
} from "../api/types";
import { Link } from "react-router-dom";
import { formatMustReadLines } from "../lib/prList";
import {
  formatRequestedAgo,
  formatRequestWait,
  REQUEST_AGE_COLORS,
  requestAgeLevel,
  reviewRequestTooltip,
  visibleReviewRequest,
} from "../lib/reviewRequest";
import { useSettings } from "../lib/settings";
import { useNow } from "../lib/useNow";
import type { StackedOnLink } from "../lib/stacked";
import {
  IconArrowDown,
  IconBolt,
  IconCheck,
  IconClock,
  IconEye,
  IconMerged,
  IconPrClosed,
  IconPrDraft,
  IconSpinner,
  IconWarning,
  IconWeight,
} from "./icons";
import { UiText } from "./UiText";

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
 * GitHub's own lifecycle state on the home row, as an icon and a word. Only
 * the out-of-the-ordinary ones: an open PR says nothing. The hues are the
 * conventional ones (purple / red / gray), each a theme token.
 */
const PR_STATE_MARK: Record<Exclude<PrGithubState, "open">, { color: string; Icon: (p: { width?: number; height?: number }) => JSX.Element }> = {
  merged: { color: "var(--kind-core)", Icon: IconMerged },
  closed: { color: "var(--risk)", Icon: IconPrClosed },
  draft: { color: "var(--fg-muted)", Icon: IconPrDraft },
};

export function PrStateMark({ state }: { state: PrGithubState }) {
  if (state === "open") return null;
  const s = PR_STATE_MARK[state];
  if (!s) return null;
  return (
    <span className="inline-flex items-center gap-1" style={{ color: s.color }} data-tip={`GitHub state: ${state}`} data-testid="pr-state">
      <s.Icon width={11} height={11} />
      <UiText>{state}</UiText>
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

type CheckState = Ci["checks"][number]["state"];
/** A check's state in the list: the mark's colors, failures first. A pending
 *  check spins: in the list it is one run still going, not the PR's state. */
const CHECK_LOOK: Record<CheckState, { color: string; order: number; Icon?: (p: { width?: number; height?: number }) => JSX.Element }> = {
  failure: { color: "var(--risk)", order: 0, Icon: IconWarning },
  pending: { color: "var(--warn)", order: 1, Icon: IconSpinner },
  success: { color: "var(--ok)", order: 2, Icon: IconCheck },
  skipped: { color: "var(--fg-faint)", order: 3 },
};

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
          <ul className="space-y-1.5" style={{ color: "var(--fg)" }}>
            {[...ci.checks]
              .sort((a, b) => CHECK_LOOK[a.state].order - CHECK_LOOK[b.state].order)
              .map((check, i) => {
                const look = CHECK_LOOK[check.state];
                return (
                  <li key={i} data-testid="ci-check" data-state={check.state} className="flex items-start gap-2">
                    <span className="flex h-4 w-3 flex-none items-center justify-center" style={{ color: look.color }} aria-hidden>
                      {look.Icon ? <look.Icon width={11} height={11} /> : "–"}
                    </span>
                    <span className="min-w-0 flex-1 break-words" style={{ color: check.state === "skipped" ? "var(--fg-muted)" : undefined }}>
                      {check.url ? (
                        <a className="hover:underline" href={check.url} target="_blank" rel="noreferrer">
                          {check.name}
                        </a>
                      ) : (
                        check.name
                      )}
                    </span>
                    <span className="flex-none text-2xs leading-4" style={{ color: check.state === "failure" ? look.color : "var(--fg-faint)" }}>
                      <UiText>{check.state}</UiText>
                    </span>
                  </li>
                );
              })}
          </ul>
        </FloatingPanel>
      ) : null}
    </span>
  );
}

const DECISION_MARK: Partial<
  Record<ReviewDecision, { label: string; color: string; title: string; Icon: (p: { width?: number; height?: number }) => JSX.Element }>
> = {
  approved: { label: "approved", color: "var(--ok)", title: "Approved on GitHub", Icon: IconCheck },
  changes_requested: {
    label: "changes requested",
    color: "var(--warn)",
    title: "Changes requested on GitHub",
    Icon: IconWarning,
  },
};

/**
 * GitHub's review decision beside the state, once there is one to tell:
 * "awaiting approval" is the merge gate nearly every open PR sits behind, so
 * it says nothing. Whether *you* were asked is the request's "you · 3d".
 */
export function ReviewDecisionMark({ decision }: { decision: ReviewDecision | null }) {
  const s = decision ? DECISION_MARK[decision] : undefined;
  if (!s) return null;
  return (
    <span className="inline-flex items-center gap-1" style={{ color: s.color }} data-tip={s.title} data-testid="review-decision">
      <s.Icon width={11} height={11} />
      <UiText>{s.label}</UiText>
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
      <UiText>{formatRequestedAgo(shown.at, at, shown.via)}</UiText>
    </span>
  );
}

/**
 * The home row's "you · 15m": a clock, who was asked and how long ago, warming
 * through the age thresholds in Settings; the tooltip spells out when, by whom
 * and how.
 */
export function ReviewRequestWait({
  request,
  state,
}: {
  request: ReviewRequest | null | undefined;
  state?: PrGithubState | null;
}) {
  const now = useNow();
  const { settings } = useSettings();
  const shown = visibleReviewRequest(request, state);
  if (!shown) return null;
  const at = new Date(now);
  // The same scale as everywhere: faint, then yellow, orange and red as it
  // crosses the thresholds in Settings.
  const level = requestAgeLevel(shown.at, at, settings.requestAgeDays);
  return (
    <span
      className="inline-flex flex-none items-center gap-1"
      style={{ color: REQUEST_AGE_COLORS[level] }}
      data-tip={reviewRequestTooltip(shown)}
      data-testid="review-request-age"
      data-level={level}
    >
      <IconClock width={11} height={11} />
      {formatRequestWait(shown.at, at, shown.via)}
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
      <UiText>{link.label}</UiText>
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
      <UiText>{link.label}</UiText>
    </a>
  );
}

export function KindChip({ kind }: { kind: Kind }) {
  const s = KIND_STYLE[kind] ?? KIND_STYLE.wiring;
  return (
    <span className="chip" style={{ color: s.color, background: s.bg }} data-tip={s.tip}>
      <UiText>{s.label}</UiText>
    </span>
  );
}

export function AttentionChip({ attention }: { attention: Attention }) {
  const s = ATTENTION_STYLE[attention] ?? ATTENTION_STYLE.skim;
  return (
    <span className="chip" style={{ color: s.color, background: s.bg }} data-attention={attention} data-tip={s.tip}>
      <s.icon width={10} height={10} />
      <UiText>{s.label}</UiText>
    </span>
  );
}

/** The same icon and hue as {@link AttentionChip}, without the chip: the sidebar's group names. */
export function AttentionIcon({ attention }: { attention: Attention }) {
  const s = ATTENTION_STYLE[attention] ?? ATTENTION_STYLE.skim;
  return (
    <span className="flex flex-none" style={{ color: s.color }}>
      <s.icon width={12} height={12} />
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
  { label: string; icon: (p: { width?: number; height?: number }) => JSX.Element; color: string }
> = {
  fast: { label: "Fast", icon: IconBolt, color: "var(--ok)" },
  heavy: { label: "Heavy", icon: IconWeight, color: "var(--warn)" },
};

/**
 * The PR list's effort mark, an icon alone: a bolt for "fast" (small, low-risk
 * must-read surface), a barbell for "heavy" (large or risky); the tooltip says
 * which and why. Renders nothing for the unbadged middle (most PRs) and for
 * PRs without an analysis: an absent mark says nothing, where a placeholder
 * would read as "checked, found nothing".
 */
export function EffortMark({ effort }: { effort?: ReviewEffort | null }) {
  if (!effort?.badge) return null;
  const s = EFFORT_STYLE[effort.badge];
  const Icon = s.icon;
  const lines = formatMustReadLines(effort.weightedMustReadLines);
  const flags = effort.riskCount === 1 ? "flag" : "flags";
  const tip = `${s.label} review: ~${lines} must-read lines · ${effort.riskCount} risk ${flags}`;
  return (
    <span
      className="inline-flex items-center"
      data-testid="effort-mark"
      data-effort={effort.badge}
      data-tip={tip}
      aria-label={tip}
      style={{ color: s.color }}
    >
      <Icon width={12} height={12} />
    </span>
  );
}

export function ChangedBadge({
  tip,
  testId,
  onClick,
  viewedAt,
  active = false,
}: {
  tip?: string;
  testId?: string;
  onClick?: () => void;
  /** the revision you viewed it in, shown as (rN) */
  viewedAt?: number;
  /** what changed is marked on the code right now */
  active?: boolean;
}) {
  const content = (
    <>
      <UiText>changed since viewed</UiText>
      {viewedAt !== undefined ? <UiText className="tabular-nums">{` (r${viewedAt})`}</UiText> : null}
    </>
  );
  const when = viewedAt !== undefined ? ` in r${viewedAt}` : "";
  const cls = "chip";
  const style = { color: "var(--warn)", background: "var(--warn-soft)" };
  if (!onClick) {
    return (
      <span className={cls} style={style} data-testid={testId} data-tip={tip ?? `Changed since you viewed it${when}`}>
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={cls}
      style={active ? { ...style, boxShadow: "inset 0 0 0 1px var(--warn)" } : style}
      onClick={onClick}
      aria-pressed={active}
      data-testid={testId}
      data-tip={tip ?? (active ? "Stop marking what changed" : `Mark on the code what changed since you viewed it${when}`)}
    >
      {content}
    </button>
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

/** A whole unit's viewed box, the same as a file's and a hunk's: a dash while partly read. */
export function ViewedBox({
  state,
  onToggle,
  tip,
  testId,
  kbd,
  busy = false,
}: {
  state: "none" | "some" | "all";
  onToggle: () => void;
  tip: string;
  testId?: string;
  kbd?: string;
  /** a save is in flight: the box already shows its outcome, so it only refuses a second click */
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === "all" ? "true" : state === "some" ? "mixed" : "false"}
      aria-label={tip}
      aria-busy={busy || undefined}
      disabled={busy}
      data-tip={busy ? "Marking…" : tip}
      data-tip-key={kbd}
      data-testid={testId}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className="flex h-4 w-4 flex-none items-center justify-center rounded-sm border transition-colors"
      style={{
        // A control's edge, held to 3:1 on the hunk headers it sits on (contrast.ts).
        borderColor: state === "none" ? "var(--fg-muted)" : "var(--ok)",
        background: state === "all" ? "var(--ok)" : "transparent",
        color: state === "all" ? "var(--bg)" : "var(--ok)",
      }}
    >
      {state === "all" ? (
        <IconCheck width={11} height={11} />
      ) : state === "some" ? (
        <span className="block h-0.5 w-2 rounded-full" style={{ background: "var(--ok)" }} />
      ) : null}
    </button>
  );
}

/**
 * How far through the hunks, as a ring and the count: the home list's right
 * edge. The tooltip carries the rest (units, effort) the row no longer spells out.
 */
export function ProgressRing({
  viewed,
  total,
  tip,
  quiet = false,
}: {
  viewed: number;
  total: number;
  tip?: string;
  /** the home row: the count sits closer and stays faint until the pointer is on
   *  the row around it (a `group`), then takes the ring's color */
  quiet?: boolean;
}) {
  const done = total > 0 && viewed === total;
  const r = 6;
  const c = 2 * Math.PI * r;
  const frac = total ? viewed / total : 0;
  return (
    <span
      className={`inline-flex items-center ${quiet ? "gap-1" : "gap-1.5"}`}
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
      {quiet ? (
        <span
          className={`text-2xs tabular-nums text-[var(--fg-faint)] transition-colors duration-150 ease-in-out ${
            done ? "group-hover:text-[var(--ok)]" : frac > 0 ? "group-hover:text-[var(--accent)]" : ""
          }`}
        >
          {viewed}/{total}
        </span>
      ) : (
        <span className="text-2xs tabular-nums" style={{ color: done ? "var(--ok)" : "var(--fg-faint)" }}>
          {viewed}/{total}
        </span>
      )}
    </span>
  );
}

/** A unit's number, on an inset tile: wherever a unit is listed. */
export function UnitNumber({ number, selected = false, tip }: { number: number; selected?: boolean; tip?: string }) {
  return (
    <span
      className="flex h-[18px] min-w-[18px] flex-none items-center justify-center rounded-[5px] px-1 text-2xs tabular-nums"
      style={{
        background: selected ? "var(--bg-raised)" : "var(--bg-inset)",
        color: selected ? "var(--fg)" : "var(--fg-muted)",
      }}
      data-tip={tip}
    >
      {number}
    </span>
  );
}

/**
 * "9 files · +120 −34", GitHub's own size stat: in the PR header, and on the
 * list row without the file count. Added green, removed red, like the diff;
 * nothing at all when there are no files yet.
 */
export function DiffSizeStat({
  size,
  files = true,
  tip = true,
  quiet = false,
  omitGenerated = false,
}: {
  size: DiffSize | null | undefined;
  files?: boolean;
  /** false when something around it explains the numbers instead */
  tip?: boolean;
  /** faint until the pointer is on the row around it (a `group`): the home list */
  quiet?: boolean;
  /** count without the generated files (Settings → Line counts) */
  omitGenerated?: boolean;
}) {
  if (!size || size.files === 0) return null;
  const g = omitGenerated ? size.generated : undefined;
  const n = size.files - (g?.files ?? 0);
  const additions = size.additions - (g?.additions ?? 0);
  const deletions = size.deletions - (g?.deletions ?? 0);
  const left = g?.files ? `; ${g.files} generated ${g.files === 1 ? "file" : "files"} left out` : "";
  return (
    <span
      className="inline-flex flex-none items-center gap-1 text-2xs tabular-nums"
      data-testid="diff-size"
      data-tip={tip ? `${n} ${n === 1 ? "file" : "files"} changed: ${additions} ${additions === 1 ? "line" : "lines"} added, ${deletions} removed${left}` : undefined}
    >
      {files ? (
        <UiText>{`${n} ${n === 1 ? "file" : "files"}`}</UiText>
      ) : null}
      {quiet ? (
        <>
          <span className="text-[var(--fg-faint)] transition-colors duration-150 ease-in-out group-hover:text-[var(--ok)]">+{additions}</span>
          <span className="text-[var(--fg-faint)] transition-colors duration-150 ease-in-out group-hover:text-[var(--risk)]">−{deletions}</span>
        </>
      ) : (
        <>
          <span style={{ color: "var(--ok)" }}>+{additions}</span>
          <span style={{ color: "var(--risk)" }}>−{deletions}</span>
        </>
      )}
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
      <UiText>{letter}</UiText>
    </span>
  );
}
