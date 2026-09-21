import { useEffect, useRef, useState } from "react";
import { errorText, isConfirmRequired } from "../api/errors";
import {
  isFileComment,
  type AddCommentInput,
  type ChatRef,
  type CommentStatus,
  type DraftComment,
  type EditCommentResult,
} from "../api/types";
import { formatComment, type DiffContext } from "../lib/agentExport";
import { compareCommentOrder } from "../lib/comments";
import { QuoteButton } from "./ChatPanel";
import { CopyBundleControls, CopyForAgentButton, type BundleSource } from "./CopyForAgent";
import { StatusChip } from "./FinishReview";
import { IconClose } from "./icons";
import { Markdown } from "./Markdown";

/**
 * What the composer is pointed at. A file-level target carries no line and no
 * side, which is exactly what the POST body will look like.
 */
export type CommentTarget =
  | { subjectType: "line"; file: string; line: number; side: "LEFT" | "RIGHT" }
  | { subjectType: "file"; file: string };

/** The chat ref for a comment — file-level ones carry no line to point at. */
export function commentRef(c: DraftComment): ChatRef {
  if (isFileComment(c)) return { kind: "comment", id: c.id, path: c.file };
  return {
    kind: "comment",
    id: c.id,
    path: c.file,
    start: c.line ?? undefined,
    side: c.side === "LEFT" ? "old" : "new",
  };
}

/** The comment a target would create, once a body is typed. */
export function targetToInput(target: CommentTarget, body: string): AddCommentInput {
  return target.subjectType === "file"
    ? { subjectType: "file", file: target.file, body }
    : { subjectType: "line", file: target.file, line: target.line, side: target.side, body };
}

/** "src/a.ts:24 (new)" or "src/a.ts (whole file)" — used wherever a comment is labelled. */
export function commentAnchorLabel(c: {
  file: string;
  line?: number | null;
  side?: "LEFT" | "RIGHT" | null;
  subjectType?: "line" | "file";
}): string {
  if (isFileComment(c)) return `${c.file} (file)`;
  return `${c.file}:${c.line}${c.side === "LEFT" ? " (old)" : ""}`;
}

export function CommentComposer({
  target,
  pending,
  exportCtx,
  onCancel,
  onSubmit,
}: {
  target: CommentTarget;
  pending: boolean;
  /** enables "copy for agent" straight from the composer, before saving */
  exportCtx?: DiffContext;
  onCancel: () => void;
  onSubmit: (body: string) => void;
}) {
  const [body, setBody] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const fileLevel = target.subjectType === "file";
  const anchorKey = fileLevel ? target.file : `${target.file}:${target.line}:${target.side}`;

  useEffect(() => {
    ref.current?.focus();
  }, [anchorKey]);

  return (
    <div
      className="surface absolute bottom-3 right-4 z-40 w-[26rem] rounded-md p-2.5 elev-3"
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && body.trim()) onSubmit(body.trim());
      }}
    >
      <div className="mb-1.5 flex items-center gap-2 font-mono text-2xs" style={{ color: "var(--fg-muted)" }}>
        <span className="truncate">{target.file}</span>
        <span className="flex-none" style={{ color: "var(--fg-faint)" }}>
          {fileLevel ? "whole file" : `:${target.line} ${target.side === "LEFT" ? "(old)" : "(new)"}`}
        </span>
        <button type="button" className="ml-auto" onClick={onCancel} style={{ color: "var(--fg-faint)" }}>
          <IconClose width={10} height={10} />
        </button>
      </div>
      <textarea
        ref={ref}
        className="input h-24 resize-none text-xs leading-[18px]"
        data-testid="composer-textarea"
        placeholder={
          fileLevel
            ? "Draft a comment about this whole file… (⌘↵ to save)"
            : "Draft a comment… (⌘↵ to save)"
        }
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="mt-1.5 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-2xs" style={{ color: "var(--fg-faint)" }}>
          Saved locally; pushed as a pending review on sync.
        </span>
        {exportCtx ? (
          <CopyForAgentButton
            testId="copy-composer"
            label="copy for agent"
            title="Copy this comment, with the code it points at, as markdown"
            disabled={!body.trim()}
            text={() =>
              formatComment(
                fileLevel
                  ? { file: target.file, line: null, side: null, subjectType: "file", body: body.trim() }
                  : { file: target.file, line: target.line, side: target.side, body: body.trim() },
                exportCtx,
              )
            }
          />
        ) : null}
        <button
          type="button"
          className="btn btn-primary ml-auto"
          data-testid="composer-save"
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
  markdown,
  editLabel,
}: {
  comment: { id: string; body: string; status?: CommentStatus };
  edit?: EditComment;
  /** truncate the read-only body (the finish-review list is space-starved) */
  clamp?: boolean;
  /** render the body as markdown instead of preformatted text */
  markdown?: boolean;
  /** the edit trigger, when the caller wants it in its own action row */
  editLabel?: string;
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
        {markdown ? (
          <div
            className={`mt-0.5 text-xs leading-5${clamp ? " line-clamp-3" : ""}`}
            style={{ color: "var(--fg)" }}
          >
            <Markdown text={comment.body} />
          </div>
        ) : (
          <p
            className={`mt-0.5 whitespace-pre-wrap text-xs leading-5${clamp ? " line-clamp-3" : ""}`}
            style={{ color: "var(--fg)" }}
          >
            {comment.body}
          </p>
        )}
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
            {editLabel ?? "edit"}
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
        className="input h-24 resize-none text-xs leading-[18px]"
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
  bundle,
  onClose,
  onJump,
  onDelete,
  onEdit,
  onQuote,
}: {
  drafts: DraftComment[];
  deleting?: boolean;
  /** diff + PR identity the agent-facing markdown needs; omit to hide copying */
  bundle?: Omit<BundleSource, "comments">;
  onClose: () => void;
  onJump: (draft: DraftComment) => void;
  onDelete?: (draft: DraftComment) => void;
  onEdit?: EditComment;
  onQuote?: (ref: ChatRef) => void;
}) {
  // Status buckets stay the outer grouping (the review lifecycle order), but
  // within each bucket the ordering matches the agent-export bundle — same
  // comparator, so the drawer and "copy for agent" can never read differently.
  const local = drafts.filter((d) => (d.status ?? "draft") === "draft").sort(compareCommentOrder);
  const pushed = drafts.filter((d) => d.status === "pushed").sort(compareCommentOrder);
  const submitted = drafts.filter((d) => d.status === "submitted").sort(compareCommentOrder);
  const ordered = [...local, ...pushed, ...submitted];

  return (
    <aside
      className="flex w-80 flex-none flex-col border-l"
      style={{ borderColor: "var(--border)", background: "var(--bg-raised)" }}
    >
      <div className="flex-none border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold">Comments</span>
          <span className="text-2xs" style={{ color: "var(--fg-faint)" }}>
            {local.length} draft · {pushed.length} pushed · {submitted.length} submitted
          </span>
          <button type="button" className="ml-auto text-xs" onClick={onClose} style={{ color: "var(--fg-faint)" }}>
            <IconClose width={10} height={10} />
          </button>
        </div>
        {bundle ? (
          <CopyBundleControls
            testId="copy-bundle-drawer"
            className="mt-1.5"
            source={{ ...bundle, comments: drafts }}
          />
        ) : null}
      </div>
      <div className="flex-1 overflow-auto">
        {drafts.length === 0 ? (
          <p className="p-3 text-xs leading-5" style={{ color: "var(--fg-faint)" }}>
            No comments yet. Hover a diff line and press the + button to write one, or use the
            file header to comment on a whole file.
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
                  <span className="flex-none" style={{ color: "var(--fg-faint)" }}>
                    {isFileComment(d) ? "(file)" : `:${d.line}`}
                  </span>
                  <StatusChip status={d.status ?? "draft"} />
                </button>
                <CommentBody comment={d} edit={onEdit} />
                <div className="mt-1 flex items-center gap-1.5">
                  {onQuote ? (
                    <QuoteButton
                      title="Ask Claude about this comment"
                      onClick={() =>
                        onQuote(commentRef(d))
                      }
                    />
                  ) : null}
                  {bundle ? (
                    <CopyForAgentButton
                      iconOnly
                      testId={`copy-comment-${d.id}`}
                      title="Copy this comment, with its code, for an agent"
                      text={() => formatComment(d, bundle.ctx)}
                    />
                  ) : null}
                {onDelete && d.status !== "submitted" ? (
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
                ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
