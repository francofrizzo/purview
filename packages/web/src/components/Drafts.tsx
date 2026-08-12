import { useEffect, useRef, useState } from "react";
import type { DraftComment } from "../api/types";
import { StatusChip } from "./FinishReview";

export interface CommentTarget {
  file: string;
  line: number;
  side: "LEFT" | "RIGHT";
}

export function CommentComposer({
  target,
  pending,
  onCancel,
  onSubmit,
}: {
  target: CommentTarget;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (body: string) => void;
}) {
  const [body, setBody] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, [target.file, target.line, target.side]);

  return (
    <div
      className="surface absolute bottom-3 right-4 z-40 w-[26rem] rounded-md p-2.5 shadow-2xl"
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && body.trim()) onSubmit(body.trim());
      }}
    >
      <div className="mb-1.5 flex items-center gap-2 font-mono text-2xs" style={{ color: "var(--fg-muted)" }}>
        <span className="truncate">{target.file}</span>
        <span style={{ color: "var(--fg-faint)" }}>
          :{target.line} {target.side === "LEFT" ? "(old)" : "(new)"}
        </span>
        <button type="button" className="ml-auto" onClick={onCancel} style={{ color: "var(--fg-faint)" }}>
          ✕
        </button>
      </div>
      <textarea
        ref={ref}
        className="input h-24 resize-none font-mono text-xs"
        placeholder="Draft a comment… (⌘↵ to save)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="mt-1.5 flex items-center gap-2">
        <span className="text-2xs" style={{ color: "var(--fg-faint)" }}>
          Saved locally; pushed as a pending review on sync.
        </span>
        <button
          type="button"
          className="btn btn-primary ml-auto"
          disabled={!body.trim() || pending}
          onClick={() => onSubmit(body.trim())}
        >
          {pending ? "saving…" : "save draft"}
        </button>
      </div>
    </div>
  );
}

/**
 * Three buckets, in the order the review lifecycle moves through them:
 * local drafts first (still editable), then what is sitting in the pending
 * review on GitHub, then what has already gone public.
 */
export function DraftsDrawer({
  drafts,
  deleting,
  onClose,
  onJump,
  onDelete,
}: {
  drafts: DraftComment[];
  deleting?: boolean;
  onClose: () => void;
  onJump: (draft: DraftComment) => void;
  onDelete?: (draft: DraftComment) => void;
}) {
  const local = drafts.filter((d) => (d.status ?? "draft") === "draft");
  const pushed = drafts.filter((d) => d.status === "pushed");
  const submitted = drafts.filter((d) => d.status === "submitted");
  const ordered = [...local, ...pushed, ...submitted];

  return (
    <aside
      className="flex w-80 flex-none flex-col border-l"
      style={{ borderColor: "var(--border)", background: "var(--bg-raised)" }}
    >
      <div
        className="flex flex-none items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: "var(--border)" }}
      >
        <span className="text-xs font-semibold">Comments</span>
        <span className="text-2xs" style={{ color: "var(--fg-faint)" }}>
          {local.length} draft · {pushed.length} pushed · {submitted.length} submitted
        </span>
        <button type="button" className="ml-auto text-xs" onClick={onClose} style={{ color: "var(--fg-faint)" }}>
          ✕
        </button>
      </div>
      <div className="flex-1 overflow-auto">
        {drafts.length === 0 ? (
          <p className="p-3 text-xs leading-5" style={{ color: "var(--fg-faint)" }}>
            No comments yet. Hover a diff line and press the + button to write one.
          </p>
        ) : (
          <ul>
            {ordered.map((d) => (
              <li key={d.id} className="border-b" style={{ borderColor: "var(--border)" }}>
                <button
                  type="button"
                  className="w-full px-3 py-2 text-left"
                  onClick={() => onJump(d)}
                >
                  <div className="flex items-center gap-1.5 font-mono text-2xs" style={{ color: "var(--fg-muted)" }}>
                    <span className="truncate">{d.file}</span>
                    <span style={{ color: "var(--fg-faint)" }}>:{d.line}</span>
                    <StatusChip status={d.status ?? "draft"} />
                  </div>
                  <p className="mt-1 text-xs leading-5" style={{ color: "var(--fg)" }}>
                    {d.body}
                  </p>
                </button>
                {onDelete && d.status !== "submitted" ? (
                  <div className="flex px-3 pb-2">
                    <button
                      type="button"
                      className="btn ml-auto"
                      disabled={deleting}
                      onClick={() => onDelete(d)}
                      title={
                        d.status === "pushed"
                          ? "Also removes it from your pending review on GitHub"
                          : "Delete this local draft"
                      }
                    >
                      delete
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
