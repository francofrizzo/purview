import { useEffect, useRef, useState } from "react";
import { errorText, isConfirmRequired } from "../api/errors";
import { useAgentName } from "../api/hooks";
import {
  isFileComment,
  type AddCommentInput,
  type ChatRef,
  type CommentStatus,
  type DeletedComment,
  type DraftComment,
  type EditCommentResult,
} from "../api/types";
import { formatComment, type DiffContext } from "../lib/agentExport";
import { capitalized } from "../lib/agentSelection";
import {
  canUndoAgentEdit,
  agentDeletedDrafts,
  compareCommentOrder,
  isAgentActor,
  isByAgent,
} from "../lib/comments";
import { CopyBundleControls, CopyForAgentButton, type BundleSource } from "./CopyForAgent";
import { IconChat, IconClose } from "./icons";
import { Markdown } from "./Markdown";
import { CommentCard } from "./CommentCard";

/**
 * What the composer is pointed at. A file-level target carries no line and no
 * side, which is exactly what the POST body will look like.
 */
export type CommentTarget =
  | { subjectType: "line"; file: string; line: number; side: "LEFT" | "RIGHT" }
  | { subjectType: "file"; file: string };

/** The chat ref for where a comment box points: its line, or its whole file. */
export function targetRef(target: CommentTarget): ChatRef {
  if (target.subjectType === "file") return { kind: "file", path: target.file };
  const side = target.side === "LEFT" ? "old" : "new";
  return { kind: "line-range", path: target.file, side, start: target.line, end: target.line };
}

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
  onSendToChat,
  chatBusy = false,
  variant = "floating",
  value,
  onChange,
}: {
  target: CommentTarget;
  pending: boolean;
  /** enables "copy for agent" straight from the composer, before saving */
  exportCtx?: DiffContext;
  onCancel: () => void;
  onSubmit: (body: string) => void;
  /** ask the review chat instead of drafting: the text goes out with this line attached */
  onSendToChat?: (body: string) => void;
  /** the chat is mid-reply: a message is queued instead of sent */
  chatBusy?: boolean;
  /**
   * "inline" sits under its line in the diff, like the thread it will join;
   * "floating" is the fallback when that line is not on screen.
   */
  variant?: "inline" | "floating";
  /** controlled text: the inline composer is a virtualized row, so it can unmount */
  value?: string;
  onChange?: (body: string) => void;
}) {
  const [own, setOwn] = useState("");
  const body = value ?? own;
  const setBody = onChange ?? setOwn;
  const ref = useRef<HTMLTextAreaElement>(null);

  const fileLevel = target.subjectType === "file";
  const anchorKey = fileLevel ? target.file : `${target.file}:${target.line}:${target.side}`;
  const where = fileLevel
    ? "this file"
    : `line ${target.line}${target.side === "LEFT" ? " (old)" : ""}`;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: variant === "inline" });
    el.setSelectionRange(el.value.length, el.value.length);
  }, [anchorKey, variant]);

  // Grow with the text, up to a cap, instead of a fixed box.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [body]);

  const floating = variant === "floating";
  return (
    <div
      data-testid="comment-composer"
      data-variant={variant}
      className={
        floating
          ? "absolute bottom-3 right-4 z-40 w-[28rem] rounded-md elev-3"
          : "w-full max-w-[46rem] rounded-md"
      }
      style={{ background: "var(--bg-raised)", border: "1px dashed var(--accent)" }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
        if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || !body.trim()) return;
        e.preventDefault();
        // ⌘⇧↵ asks the chat; ⌘↵ saves the draft.
        if (e.shiftKey) {
          if (onSendToChat) onSendToChat(body.trim());
        } else onSubmit(body.trim());
      }}
    >
      <div className="flex items-center gap-2 px-3 pt-2 text-2xs">
        <span className="font-medium" style={{ color: "var(--accent)" }}>
          New comment
        </span>
        <span className="min-w-0 truncate" style={{ color: "var(--fg-faint)" }}>
          {floating ? (
            <span className="font-mono">
              {target.file}
              {fileLevel ? "" : `:${target.line}${target.side === "LEFT" ? " (old)" : ""}`}
            </span>
          ) : (
            `on ${where}`
          )}
        </span>
        <button
          type="button"
          className="ml-auto flex-none rounded p-1 hover:bg-[var(--bg-hover)]"
          onClick={onCancel}
          title="Discard (esc)"
          aria-label="Discard"
          style={{ color: "var(--fg-faint)" }}
        >
          <IconClose width={10} height={10} />
        </button>
      </div>
      <textarea
        ref={ref}
        rows={3}
        className="block w-full resize-none bg-transparent px-3 py-1.5 text-[13px] leading-[20px] outline-none"
        style={{ color: "var(--fg)" }}
        data-testid="composer-textarea"
        placeholder={fileLevel ? "Comment on this file…" : "Comment on this line…"}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2 border-t px-2 py-1.5" style={{ borderColor: "var(--border)" }}>
        <span className="hidden text-2xs sm:inline" style={{ color: "var(--fg-faint)" }}>
          markdown · ⌘↵ save{onSendToChat ? " · ⌘⇧↵ ask chat" : ""}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {exportCtx ? (
            <CopyForAgentButton
              iconOnly
              testId="copy-composer"
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
          {onSendToChat ? (
            <button
              type="button"
              className="btn"
              data-testid="composer-send-to-chat"
              disabled={!body.trim()}
              title={
                chatBusy
                  ? "The chat is still replying: this is queued and sent when it finishes, with this line attached. (⌘⇧↵)"
                  : "Ask the review chat instead, with this line attached. Nothing is saved as a draft. (⌘⇧↵)"
              }
              onClick={() => onSendToChat(body.trim())}
            >
              <IconChat width={11} height={11} />
              {chatBusy ? "queue for chat" : "ask chat"}
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-primary"
            data-testid="composer-save"
            title="Saved on this machine; it reaches GitHub when you sync or finish the review. (⌘↵)"
            disabled={!body.trim() || pending}
            onClick={() => onSubmit(body.trim())}
          >
            {pending ? "saving…" : "save draft"}
          </button>
        </span>
      </div>
    </div>
  );
}

/** "by Claude" — on a draft the review chat created, named after the harness that wrote it. */
export function ByAgentChip({ comment }: { comment: Pick<DraftComment, "author"> }) {
  const name = useAgentName(isAgentActor(comment.author) ? comment.author.agent : null);
  if (!isByAgent(comment)) return null;
  return (
    <span
      className="chip flex-none"
      data-testid="by-agent"
      style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
      title={`Drafted by ${name} in the review chat`}
    >
      by {name}
    </span>
  );
}

/** "edited by Claude · undo" — while the chat's latest edit to a draft is still in effect. */
export function AgentEditNote({
  comment,
  onUndo,
  busy,
}: {
  comment: Pick<DraftComment, "id" | "status" | "lastEditedBy" | "history">;
  onUndo?: (id: string) => void;
  busy?: boolean;
}) {
  const name = useAgentName(isAgentActor(comment.lastEditedBy) ? comment.lastEditedBy.agent : null);
  if (!canUndoAgentEdit(comment)) return null;
  return (
    <p className="mt-1 text-2xs leading-4" style={{ color: "var(--fg-faint)" }}>
      edited by {name}
      {onUndo ? (
        <>
          {" · "}
          <button
            type="button"
            data-testid={`undo-edit-${comment.id}`}
            className="underline"
            style={{ color: "var(--fg-muted)" }}
            disabled={busy}
            onClick={() => onUndo(comment.id)}
            title={`Go back to the text this draft had before ${name}'s edit`}
          >
            undo
          </button>
        </>
      ) : null}
    </p>
  );
}

/** An agent actor's name, e.g. in "Claude deleted a draft". */
function AgentName({ actor }: { actor: DeletedComment["deletedBy"] }) {
  const name = useAgentName(isAgentActor(actor) ? actor.agent : null);
  return <>{capitalized(name)}</>;
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
  bodyClass = "text-xs leading-5",
  editing,
  onEditingChange,
}: {
  comment: { id: string; body: string; status?: CommentStatus };
  edit?: EditComment;
  /** truncate the read-only body (the finish-review list is space-starved) */
  clamp?: boolean;
  /** render the body as markdown instead of preformatted text */
  markdown?: boolean;
  /** the edit trigger, when the caller wants it in its own action row */
  editLabel?: string;
  /** size of the read-only body text */
  bodyClass?: string;
  /**
   * Controlled editing: the caller owns the trigger (an icon in its header),
   * this owns the editor. Omitted, the body shows its own "edit" button.
   */
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
}) {
  const status = comment.status ?? "draft";
  const [mode, setModeState] = useState<"view" | "edit" | "confirm">("view");
  const controlled = onEditingChange !== undefined;
  const setMode = (next: "view" | "edit" | "confirm") => {
    setModeState(next);
    if (next === "view") onEditingChange?.(false);
  };
  useEffect(() => {
    if (controlled && editing && mode === "view") {
      setValue(comment.body);
      setModeState("edit");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
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
          <div className={`mt-0.5 max-w-[72ch]${clamp ? " line-clamp-3" : ""}`} style={{ color: "var(--fg)" }}>
            <Markdown text={comment.body} textClass={bodyClass} ink="var(--fg)" />
          </div>
        ) : (
          <p
            className={`mt-0.5 max-w-[72ch] whitespace-pre-wrap ${bodyClass}${clamp ? " line-clamp-3" : ""}`}
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
        {edit && !controlled ? (
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
  onDeleteMany,
  onEdit,
  onQuote,
  deleted = [],
  onRestore,
  onUndoEdit,
  undoing,
}: {
  drafts: DraftComment[];
  /** the server's trash; drafts the chat deleted get a restore notice */
  deleted?: DeletedComment[];
  onRestore?: (id: string) => void;
  onUndoEdit?: (id: string) => void;
  /** a restore or undo is in flight */
  undoing?: boolean;
  deleting?: boolean;
  /** diff + PR identity the agent-facing markdown needs; omit to hide copying */
  bundle?: Omit<BundleSource, "comments">;
  onClose: () => void;
  onJump: (draft: DraftComment) => void;
  onDelete?: (draft: DraftComment) => void;
  /** bulk delete, for "copy & delete" */
  onDeleteMany?: (ids: string[]) => Promise<unknown>;
  onEdit?: EditComment;
  onQuote?: (ref: ChatRef) => void;
}) {
  // Status buckets stay the outer grouping (the review lifecycle order), but
  // within each bucket the ordering matches the agent-export bundle — same
  // comparator, so the drawer and "copy for agent" can never read differently.
  const local = drafts.filter((d) => (d.status ?? "draft") === "draft").sort(compareCommentOrder);
  const pushed = drafts.filter((d) => d.status === "pushed").sort(compareCommentOrder);
  const submitted = drafts.filter((d) => d.status === "submitted").sort(compareCommentOrder);
  // Dismissing a notice only hides it here; the draft stays restorable until
  // the server's trash lets it go.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const chatDeleted = onRestore ? agentDeletedDrafts(deleted, dismissed) : [];

  return (
    <aside
      className="flex w-[22rem] flex-none flex-col border-l"
      style={{ borderColor: "var(--border)", background: "var(--bg-raised)" }}
    >
      <div className="flex-none border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold">Comments</span>
          {/* Only the stages that hold something; nothing at all says nothing. */}
          <span className="text-2xs" style={{ color: "var(--fg-faint)" }}>
            {[
              local.length ? `${local.length} draft` : "",
              pushed.length ? `${pushed.length} pushed` : "",
              submitted.length ? `${submitted.length} submitted` : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <button type="button" className="ml-auto text-xs" onClick={onClose} style={{ color: "var(--fg-faint)" }}>
            <IconClose width={10} height={10} />
          </button>
        </div>
        {bundle && drafts.length > 0 ? (
          <CopyBundleControls
            testId="copy-bundle-drawer"
            className="mt-1.5"
            source={{ ...bundle, comments: drafts }}
            onDeleteCopied={onDeleteMany}
          />
        ) : null}
      </div>
      {chatDeleted.length ? (
        <ul className="flex-none border-b" style={{ borderColor: "var(--border)" }}>
          {chatDeleted.map((d) => (
            <li
              key={d.id}
              data-testid={`agent-deleted-${d.id}`}
              className="flex items-center gap-1.5 px-3 py-1.5 text-2xs"
              style={{ background: "var(--bg-inset)", color: "var(--fg-muted)" }}
            >
              <span className="min-w-0 flex-1 truncate" title={d.body}>
                <AgentName actor={d.deletedBy} /> deleted a draft on{" "}
                <span className="font-mono">{commentAnchorLabel(d)}</span>
              </span>
              <button
                type="button"
                data-testid={`restore-${d.id}`}
                className="flex-none underline"
                disabled={undoing}
                onClick={() => onRestore?.(d.id)}
              >
                undo
              </button>
              <button
                type="button"
                className="flex-none"
                style={{ color: "var(--fg-faint)" }}
                title="Dismiss"
                onClick={() => setDismissed((cur) => new Set([...cur, d.id]))}
              >
                <IconClose width={9} height={9} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex-1 overflow-auto">
        {drafts.length === 0 ? (
          <p className="p-3 text-xs leading-5" style={{ color: "var(--fg-faint)" }}>
            No comments yet. Hover a diff line and press the + button to write one, or use the
            file header to comment on a whole file.
          </p>
        ) : (
          <div className="flex flex-col gap-3 p-2.5">
            {(
              [
                ["Drafts", "Only on this machine", local],
                ["Pushed", "In your pending review on GitHub", pushed],
                ["Submitted", "Public on GitHub", submitted],
              ] as const
            )
              .filter(([, , list]) => list.length)
              .map(([title, hint, list]) => (
                <section key={title} data-testid={`drawer-group-${title.toLowerCase()}`}>
                  <h3 className="mb-1.5 flex items-baseline gap-1.5 px-0.5 text-2xs">
                    <span className="font-semibold" style={{ color: "var(--fg-muted)" }}>
                      {title}
                    </span>
                    <span className="tabular-nums" style={{ color: "var(--fg-faint)" }}>
                      {list.length}
                    </span>
                    <span className="truncate" style={{ color: "var(--fg-faint)" }}>
                      · {hint}
                    </span>
                  </h3>
                  <ul className="flex flex-col gap-1.5">
                    {list.map((d) => (
                      <li key={d.id}>
                        <CommentCard
                          comment={d}
                          anchor={{ label: commentAnchorLabel(d), onJump: () => onJump(d) }}
                          actions={{
                            onEdit,
                            onDelete,
                            deleting,
                            onQuote,
                            exportCtx: bundle?.ctx,
                            onUndoEdit,
                            undoing,
                          }}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
          </div>
        )}
      </div>
    </aside>
  );
}
