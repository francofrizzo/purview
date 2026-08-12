import { useEffect, useRef, useState } from "react";
import { errorText, isConfirmRequired } from "../api/errors";
import type { CommentStatus, DraftComment, EditCommentResult } from "../api/types";
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

export type EditComment = (input: {
  id: string;
  body: string;
  confirm?: boolean;
}) => Promise<EditCommentResult>;

const EDIT_HINT: Record<CommentStatus, string> = {
  draft: "Local only — nothing leaves the machine until you sync.",
  pushed: "Also updates the comment in your pending review on GitHub.",
  submitted: "This comment is already public on GitHub.",
};

/**
 * A comment's body, with an inline editor. Handles the whole edit lifecycle:
 * the explicit confirmation an already-public comment requires, and the
 * "saved locally but GitHub was not updated" outcome the server can return.
 */
export function CommentBody({
  comment,
  edit,
  clamp,
}: {
  comment: { id: string; body: string; status?: CommentStatus };
  edit?: EditComment;
  /** truncate the read-only body (the finish-review list is space-starved) */
  clamp?: boolean;
}) {
  const status = comment.status ?? "draft";
  const [mode, setMode] = useState<"view" | "edit" | "confirm">("view");
  const [value, setValue] = useState(comment.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (mode === "edit") ref.current?.focus();
  }, [mode]);

  // Someone else (a sync, a refetch) changed the text while we were idle.
  useEffect(() => {
    if (mode === "view") setValue(comment.body);
  }, [comment.body, mode]);

  const cancel = () => {
    setMode("view");
    setValue(comment.body);
    setError(null);
  };

  const save = async (confirm?: boolean) => {
    if (!edit) return;
    const body = value.trim();
    if (!body) {
      setError("A comment cannot be empty.");
      return;
    }
    if (body === comment.body) {
      cancel();
      return;
    }
    if (status === "submitted" && !confirm) {
      setMode("confirm");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await edit({ id: comment.id, body, confirm });
      setWarning(res.remote && res.remote.ok === false ? res.remote.reason : null);
      setMode("view");
    } catch (err) {
      // Defensive: the server is the authority on when confirmation is needed.
      if (isConfirmRequired(err)) setMode("confirm");
      else {
        setError(errorText(err));
        setMode("edit");
      }
    } finally {
      setBusy(false);
    }
  };

  if (mode === "view") {
    return (
      <div>
        <p
          className={`mt-0.5 whitespace-pre-wrap text-xs leading-5${clamp ? " line-clamp-3" : ""}`}
          style={{ color: "var(--fg)" }}
        >
          {comment.body}
        </p>
        {warning ? (
          <p
            className="mt-1 rounded px-1.5 py-1 text-2xs leading-4"
            style={{ background: "var(--warn-soft)", color: "var(--warn)" }}
          >
            Saved locally, but GitHub was not updated: {warning}
          </p>
        ) : null}
        {edit ? (
          <button
            type="button"
            data-testid={`edit-${comment.id}`}
            className="btn mt-1"
            onClick={() => {
              setValue(comment.body);
              setMode("edit");
            }}
          >
            edit
          </button>
        ) : null}
      </div>
    );
  }

  if (mode === "confirm") {
    return (
      <div
        className="mt-1 rounded p-2"
        style={{ background: "var(--risk-soft)", border: "1px solid var(--risk)" }}
      >
        <p className="text-2xs leading-4" style={{ color: "var(--risk)" }}>
          This comment is already <strong>submitted and publicly visible</strong> on GitHub. Editing
          it changes what everyone else sees, and GitHub will show it as edited.
        </p>
        <div className="mt-1.5 flex items-center gap-1.5">
          <button type="button" className="btn" disabled={busy} onClick={() => setMode("edit")}>
            back
          </button>
          <button
            type="button"
            data-testid={`confirm-public-${comment.id}`}
            className="btn ml-auto"
            style={{ color: "var(--risk)", borderColor: "var(--risk)" }}
            disabled={busy}
            onClick={() => void save(true)}
          >
            {busy ? "saving…" : "edit publicly"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="mt-1"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          cancel();
        }
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void save();
        }
      }}
    >
      <textarea
        ref={ref}
        data-testid={`editor-${comment.id}`}
        className="input h-24 resize-none font-mono text-xs"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <p className="mt-1 text-2xs leading-4" style={{ color: "var(--fg-faint)" }}>
        {EDIT_HINT[status]} (esc to cancel, ⌘↵ to save)
      </p>
      {error ? (
        <p className="mt-1 text-2xs leading-4" style={{ color: "var(--risk)" }}>
          {error}
        </p>
      ) : null}
      <div className="mt-1.5 flex items-center gap-1.5">
        <button type="button" className="btn" disabled={busy} onClick={cancel}>
          cancel
        </button>
        <button
          type="button"
          data-testid={`save-${comment.id}`}
          className="btn btn-primary ml-auto"
          disabled={busy || !value.trim()}
          onClick={() => void save()}
        >
          {busy ? "saving…" : "save"}
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
  onEdit,
}: {
  drafts: DraftComment[];
  deleting?: boolean;
  onClose: () => void;
  onJump: (draft: DraftComment) => void;
  onDelete?: (draft: DraftComment) => void;
  onEdit?: EditComment;
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
              <li key={d.id} className="border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 text-left font-mono text-2xs"
                  style={{ color: "var(--fg-muted)" }}
                  onClick={() => onJump(d)}
                  title="Jump to this file"
                >
                  <span className="truncate">{d.file}</span>
                  <span style={{ color: "var(--fg-faint)" }}>:{d.line}</span>
                  <StatusChip status={d.status ?? "draft"} />
                </button>
                <CommentBody comment={d} edit={onEdit} />
                {onDelete && d.status !== "submitted" ? (
                  <div className="mt-1 flex">
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
