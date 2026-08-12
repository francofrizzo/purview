import { useEffect, useRef } from "react";
import { ATTENTIONS, KINDS, type Attention, type Kind, type ReviewUnit } from "../api/types";
import { IconChat } from "./icons";

export function ReclassifyPopover({
  unit,
  onClose,
  onApply,
  onAskClaude,
}: {
  unit: ReviewUnit;
  onClose: () => void;
  onApply: (patch: Partial<ReviewUnit>) => void;
  /** Attaches this unit as a chat ref and opens the panel. */
  onAskClaude?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      e.stopPropagation();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="surface absolute right-1 top-6 z-30 w-56 rounded-md p-2 shadow-xl"
      onClick={(e) => e.stopPropagation()}
    >
      {onAskClaude ? (
        <button
          type="button"
          data-testid={`ask-claude-${unit.id}`}
          className="btn mb-2 w-full justify-start"
          onClick={() => {
            onAskClaude();
            onClose();
          }}
        >
          <IconChat width={11} height={11} />
          ask Claude about this unit
        </button>
      ) : null}
      <div className="mb-1 text-2xs uppercase tracking-wide" style={{ color: "var(--fg-faint)" }}>
        kind
      </div>
      <div className="mb-2 flex flex-wrap gap-1">
        {KINDS.map((k: Kind) => (
          <button
            key={k}
            type="button"
            className="chip"
            style={{
              background: k === unit.kind ? "var(--accent-soft)" : "var(--bg-inset)",
              color: k === unit.kind ? "var(--accent)" : "var(--fg-muted)",
            }}
            onClick={() => onApply({ kind: k })}
          >
            {k}
          </button>
        ))}
      </div>
      <div className="mb-1 text-2xs uppercase tracking-wide" style={{ color: "var(--fg-faint)" }}>
        attention
      </div>
      <div className="flex flex-wrap gap-1">
        {ATTENTIONS.map((a: Attention) => (
          <button
            key={a}
            type="button"
            className="chip"
            style={{
              background: a === unit.attention ? "var(--accent-soft)" : "var(--bg-inset)",
              color: a === unit.attention ? "var(--accent)" : "var(--fg-muted)",
            }}
            onClick={() => onApply({ attention: a })}
          >
            {a}
          </button>
        ))}
      </div>
      <p className="mt-2 text-2xs leading-4" style={{ color: "var(--fg-faint)" }}>
        Corrections are logged for the analysis skill to learn from.
      </p>
    </div>
  );
}
