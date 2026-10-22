import { useRef, useState, type ReactNode } from "react";
import type { ReactionContent, RemoteComment } from "../api/types";
import { FloatingPanel } from "./FloatingPanel";
import { IconReact } from "./icons";

export const REACTION_EMOJI: Record<ReactionContent, string> = {
  THUMBS_UP: "👍", THUMBS_DOWN: "👎", LAUGH: "😄", HOORAY: "🎉",
  CONFUSED: "😕", HEART: "❤️", ROCKET: "🚀", EYES: "👀",
};

export interface ReactionActions {
  onReact?: (comment: RemoteComment, content: ReactionContent, on: boolean) => void;
  reacting?: string | null;
  reactionError?: { id: string; message: string } | null;
}

export function ReactionPicker({ comment, onReact, reacting, renderButton }: ReactionActions & {
  comment: RemoteComment;
  renderButton?: (open: () => void, disabled: boolean) => ReactNode;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const busy = reacting === comment.id;
  if (!onReact) return null;
  return (
    <span ref={anchorRef} className="inline-flex">
      {renderButton ? renderButton(() => setOpen((v) => !v), busy) : (
        <button type="button" data-testid={`react-${comment.id}`} aria-label="Add a reaction on GitHub"
          aria-expanded={open} disabled={busy}
          data-tip="Add a reaction on GitHub"
          className="flex-none rounded p-0.5 opacity-50 transition-opacity hover:opacity-100 disabled:opacity-40"
          style={{ color: "var(--fg-muted)" }}
          onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}><IconReact width={11} height={11} /></button>
      )}
      {open ? (
        <FloatingPanel anchorRef={anchorRef} onClose={() => setOpen(false)} label="Add reaction" className="flex gap-1 p-2">
          {(Object.keys(REACTION_EMOJI) as ReactionContent[]).map((content) => (
            <button key={content} type="button" data-testid={`react-pick-${content}`}
              aria-label={content.toLowerCase().replaceAll("_", " ")}
              aria-pressed={!!comment.reactions?.find((r) => r.content === content)?.mine}
              disabled={busy} className="rounded p-1 hover:bg-[var(--bg-hover)] disabled:opacity-40"
              onClick={(e) => {
                e.stopPropagation();
                onReact(comment, content, !comment.reactions?.find((r) => r.content === content)?.mine);
                setOpen(false);
              }}>{REACTION_EMOJI[content]}</button>
          ))}
        </FloatingPanel>
      ) : null}
    </span>
  );
}

export function ReactionPills({ comment, onReact, reacting }: ReactionActions & { comment: RemoteComment }) {
  if (!comment.reactions?.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      {comment.reactions.map((r) => (
        <button key={r.content} type="button" className="chip"
          data-testid={`reaction-${r.content}`} data-mine={String(r.mine)}
          aria-label={`${r.content.toLowerCase().replaceAll("_", " ")}: ${r.count}`}
          aria-pressed={r.mine} disabled={!onReact || reacting === comment.id}
          style={{ color: r.mine ? "var(--accent)" : "var(--fg-muted)",
            background: r.mine ? "var(--accent-soft)" : "var(--bg-inset)",
            border: `1px solid ${r.mine ? "var(--accent)" : "var(--border)"}` }}
          onClick={(e) => { e.stopPropagation(); onReact?.(comment, r.content, !r.mine); }}>
          {REACTION_EMOJI[r.content]} {r.count}
        </button>
      ))}
      <ReactionPicker comment={comment} onReact={onReact} reacting={reacting} />
    </div>
  );
}

export function ReactionError({ comment, reactionError }: ReactionActions & { comment: RemoteComment }) {
  return reactionError?.id === comment.id ? (
    <p role="alert" className="mt-1 text-2xs" style={{ color: "var(--risk)" }}>{reactionError.message}</p>
  ) : null;
}
