import type { Attention, Kind, RiskFlag } from "../api/types";
import { RISK_META } from "./icons";

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

export function RiskFlags({ flags, size = 12 }: { flags: RiskFlag[]; size?: number }) {
  if (!flags?.length) return null;
  return (
    <span className="inline-flex items-center gap-1" style={{ color: "var(--risk)" }}>
      {flags.map((f) => {
        const meta = RISK_META[f];
        if (!meta) return null;
        const Icon = meta.icon;
        return (
          <span
            key={f}
            title={`risk: ${meta.label}`}
            className="inline-flex items-center rounded p-px"
            style={{ background: "var(--risk-soft)" }}
          >
            <Icon width={size} height={size} />
          </span>
        );
      })}
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
