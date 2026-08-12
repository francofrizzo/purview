import { useEffect, useRef, useState } from "react";
import type { DraftComment } from "../api/types";

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

export function DraftsDrawer({
  drafts,
  onClose,
  onJump,
}: {
  drafts: DraftComment[];
  onClose: () => void;
  onJump: (draft: DraftComment) => void;
}) {
  const pending = drafts.filter((d) => d.status !== "posted");
  const posted = drafts.filter((d) => d.status === "posted");

  return (
    <aside
      className="flex w-80 flex-none flex-col border-l"
      style={{ borderColor: "var(--border)", background: "var(--bg-raised)" }}
    >
      <div
        className="flex flex-none items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: "var(--border)" }}
      >
        <span className="text-xs font-semibold">Draft comments</span>
        <span className="text-2xs" style={{ color: "var(--fg-faint)" }}>
          {pending.length} pending
        </span>
        <button type="button" className="ml-auto text-xs" onClick={onClose} style={{ color: "var(--fg-faint)" }}>
          ✕
        </button>
      </div>
      <div className="flex-1 overflow-auto">
        {drafts.length === 0 ? (
          <p className="p-3 text-xs leading-5" style={{ color: "var(--fg-faint)" }}>
            No drafts. Hover a diff line and press the + button to write one.
          </p>
        ) : (
          <ul>
            {[...pending, ...posted].map((d) => (
              <li key={d.id} className="border-b" style={{ borderColor: "var(--border)" }}>
                <button
                  type="button"
                  className="w-full px-3 py-2 text-left"
                  onClick={() => onJump(d)}
                >
                  <div className="flex items-center gap-1.5 font-mono text-2xs" style={{ color: "var(--fg-muted)" }}>
                    <span className="truncate">{d.file}</span>
                    <span style={{ color: "var(--fg-faint)" }}>:{d.line}</span>
                    {d.status === "posted" ? (
                      <span className="chip ml-auto" style={{ background: "var(--bg-inset)", color: "var(--fg-faint)" }}>
                        posted
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs leading-5" style={{ color: "var(--fg)" }}>
                    {d.body}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
