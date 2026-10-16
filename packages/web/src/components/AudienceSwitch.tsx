import type { CommentAudience } from "../api/types";
import { IconGithub, IconSparkles } from "./icons";

/**
 * The global switch: who new comments are for. "GitHub" means part of your
 * review, on its way to the pending review and the submit; "agent" means a
 * note for a coding agent, which never leaves this machine. One setting for
 * the whole app (the CLI and the chat follow it), so it reads the same in the
 * top bar, the composer and the comments drawer.
 */
export const AUDIENCE_LABEL: Record<CommentAudience, string> = { github: "GitHub", agent: "agent" };

export const AUDIENCE_HINT: Record<CommentAudience, string> = {
  github: "New comments go into your GitHub review",
  agent: "New comments are notes for a coding agent and never go to GitHub",
};

export function AudienceSwitch({
  value,
  onChange,
  disabled,
  compact,
  testId = "audience-switch",
}: {
  value: CommentAudience;
  onChange: (next: CommentAudience) => void;
  disabled?: boolean;
  /** icons only (the top bar) */
  compact?: boolean;
  testId?: string;
}) {
  const options: { id: CommentAudience; icon: JSX.Element }[] = [
    { id: "github", icon: <IconGithub width={11} height={11} /> },
    { id: "agent", icon: <IconSparkles width={11} height={11} /> },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Who new comments are for"
      data-testid={testId}
      data-value={value}
      className="btn-group"
    >
      {options.map((o) => {
        const on = o.id === value;
        const ink = o.id === "agent" ? "var(--agent)" : "var(--accent)";
        const tint = o.id === "agent" ? "var(--agent-soft)" : "var(--accent-soft)";
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={`Comments for ${AUDIENCE_LABEL[o.id]}`}
            data-testid={`${testId}-${o.id}`}
            className="btn"
            data-tip={AUDIENCE_HINT[o.id]}
            data-tip-key="a"
            disabled={disabled}
            onClick={() => onChange(o.id)}
            style={on ? { color: ink, background: tint, borderColor: ink } : undefined}
          >
            {o.icon}
            {compact ? null : AUDIENCE_LABEL[o.id]}
          </button>
        );
      })}
    </div>
  );
}
