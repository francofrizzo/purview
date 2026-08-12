import type { Attention, Kind, RiskFlag } from "../api/types";
import { RISK_META } from "./icons";

const KIND_STYLE: Record<Kind, { label: string; color: string; bg: string }> = {
  "core-logic": { label: "core", color: "#c4a7ff", bg: "rgba(160, 120, 255, 0.14)" },
  "connective-tissue": { label: "glue", color: "#7ec9d8", bg: "rgba(94, 180, 200, 0.14)" },
  wiring: { label: "wiring", color: "#9aa4b4", bg: "rgba(150, 160, 180, 0.13)" },
  ripple: { label: "ripple", color: "#d8b98a", bg: "rgba(200, 160, 100, 0.13)" },
  tests: { label: "tests", color: "#8fc99b", bg: "rgba(100, 190, 130, 0.13)" },
  docs: { label: "docs", color: "#a0a8bb", bg: "rgba(140, 150, 175, 0.12)" },
};

const ATTENTION_STYLE: Record<Attention, { label: string; color: string; bg: string }> = {
  "must-read": { label: "must-read", color: "var(--risk)", bg: "var(--risk-soft)" },
  skim: { label: "skim", color: "var(--warn)", bg: "var(--warn-soft)" },
  skip: { label: "skip", color: "var(--fg-faint)", bg: "rgba(128,128,128,0.1)" },
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
