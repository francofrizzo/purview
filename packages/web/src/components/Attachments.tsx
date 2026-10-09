import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type ReactElement,
  type RefObject,
} from "react";
import { attachmentSrc } from "../api/client";
import { errorText } from "../api/errors";
import { useAttachments, useDeleteAttachment, useUploadAttachment } from "../api/hooks";
import type { Attachment } from "../api/types";
import {
  ATTACHMENT_ACCEPT,
  attachmentFileError,
  attachmentIdOf,
  attachmentMarkdown,
  attachmentRefs,
  insertAtSelection,
  isGithubAssetUrl,
  mediaFiles,
  removeAttachmentRef,
} from "../lib/attachments";
import { IconClose, IconPaperclip, IconSpinner } from "./icons";
import type { AttachmentScope, LocalMedia } from "./Markdown";

/**
 * Pictures in a comment editor. One hook owns the whole flow — paste, drop,
 * the paperclip's file picker — and the strip under the textarea shows what
 * the body refers to, each with a remove. The body stays the source of truth:
 * a thumbnail is drawn for every `purview-attachment:` reference in it, and
 * removing one takes the reference out of the text.
 */

export interface AttachmentEditor {
  /** spread onto the textarea's wrapper (drop) and the textarea (paste) */
  dropProps: {
    onDragOver: (e: DragEvent) => void;
    onDragLeave: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
  };
  onPaste: (e: ClipboardEvent) => void;
  /** a file is being dragged over the editor */
  dragging: boolean;
  /** uploads in flight, by file name */
  uploading: string[];
  error: string | null;
  /** open the file picker */
  pick: () => void;
  /** the hidden input the picker uses; render it once inside the editor */
  input: ReactElement;
  /** take a picture out of the body (and off the local server when nothing else uses it) */
  remove: (id: string) => void;
  /** every id the editor uploaded in this session, for discard-time cleanup */
  uploaded: string[];
  /** the editor was discarded: drop what it uploaded and the body no longer holds */
  discard: () => void;
}

export function useAttachmentEditor({
  prKey,
  textareaRef,
  body,
  setBody,
}: {
  prKey: string;
  textareaRef: RefObject<HTMLTextAreaElement>;
  body: string;
  setBody: (next: string) => void;
}): AttachmentEditor {
  const upload = useUploadAttachment(prKey);
  const del = useDeleteAttachment(prKey);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  // The latest body, for inserts that land after an await.
  const bodyRef = useRef(body);
  bodyRef.current = body;

  const addFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setError(null);
      for (const file of files) {
        const problem = attachmentFileError(file);
        if (problem) {
          setError(problem);
          continue;
        }
        const name = file.name || "image";
        setUploading((u) => [...u, name]);
        try {
          const a = await upload.mutateAsync(file);
          setUploaded((ids) => [...ids, a.id]);
          const el = textareaRef.current;
          const sel = el
            ? { start: el.selectionStart, end: el.selectionEnd }
            : { start: bodyRef.current.length, end: bodyRef.current.length };
          const next = insertAtSelection(bodyRef.current, sel, attachmentMarkdown(a.name, a.id));
          bodyRef.current = next.body;
          setBody(next.body);
          requestAnimationFrame(() => {
            const ta = textareaRef.current;
            if (!ta) return;
            ta.focus({ preventScroll: true });
            ta.setSelectionRange(next.caret, next.caret);
          });
        } catch (err) {
          setError(`Could not attach ${name}: ${errorText(err)}`);
        } finally {
          setUploading((u) => {
            const i = u.indexOf(name);
            return i === -1 ? u : [...u.slice(0, i), ...u.slice(i + 1)];
          });
        }
      }
    },
    [upload, setBody, textareaRef],
  );

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

  const dropProps = {
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      if (!dragging) setDragging(true);
    },
    onDragLeave: (e: DragEvent) => {
      // Leaving for a child element fires too; only a real exit ends the state.
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(false);
      void addFiles(mediaFiles(e.dataTransfer.files));
    },
  };

  const onPaste = (e: ClipboardEvent) => {
    const files = mediaFiles(e.clipboardData?.files);
    if (files.length === 0) return;
    // A picture on the clipboard, not text: ours to handle.
    e.preventDefault();
    void addFiles(files);
  };

  const remove = (id: string) => {
    const next = removeAttachmentRef(bodyRef.current, id);
    bodyRef.current = next;
    setBody(next);
    // Best effort: the server refuses while another comment still uses it.
    del.mutate(id, { onError: () => undefined });
  };

  const discard = () => {
    const stillUsed = new Set(attachmentRefs(bodyRef.current));
    for (const id of uploaded) if (!stillUsed.has(id)) del.mutate(id, { onError: () => undefined });
  };

  const input = (
    <input
      ref={inputRef}
      type="file"
      accept={ATTACHMENT_ACCEPT}
      multiple
      className="hidden"
      data-testid="attachment-input"
      onChange={(e) => {
        void addFiles(mediaFiles(e.target.files));
        e.target.value = "";
      }}
    />
  );

  return {
    dropProps,
    onPaste,
    dragging,
    uploading,
    error,
    pick: () => inputRef.current?.click(),
    input,
    remove,
    uploaded,
    discard,
  };
}

/** The paperclip: opens the file picker. */
export function AttachButton({
  editor,
  testId = "attach",
  disabled = false,
}: {
  editor: AttachmentEditor;
  testId?: string;
  /** while the editor previews: pictures go in through the textarea */
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="flex-none rounded p-1 enabled:hover:bg-[var(--bg-hover)] disabled:opacity-50"
      style={{ color: "var(--fg-faint)" }}
      title={
        disabled
          ? "Switch to Write to attach an image"
          : "Attach an image (or paste / drop one). It is uploaded to GitHub when the comment is pushed."
      }
      aria-label="Attach an image"
      data-testid={testId}
      disabled={disabled}
      onClick={editor.pick}
    >
      <IconPaperclip width={12} height={12} />
    </button>
  );
}

/**
 * Thumbnails for the pictures the body refers to, with a remove each, plus
 * the uploads still in flight and the last problem. Nothing when the body
 * has no pictures and nothing is happening.
 */
export function AttachmentStrip({
  prKey,
  body,
  editor,
}: {
  prKey: string;
  body: string;
  editor: AttachmentEditor;
}) {
  const ids = attachmentRefs(body);
  const { data: all = [] } = useAttachments(prKey);
  if (ids.length === 0 && editor.uploading.length === 0 && !editor.error) return null;
  return (
    <div className="px-3 pb-1.5" data-testid="attachment-strip">
      {ids.length > 0 || editor.uploading.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {ids.map((id) => {
            const a = all.find((x) => x.id === id);
            const video = a?.mime.startsWith("video/");
            return (
              <div
                key={id}
                className="group/thumb relative h-14 w-14 flex-none overflow-hidden rounded"
                style={{ background: "var(--bg-inset)", border: "1px solid var(--border)" }}
                title={a?.name ?? "attachment"}
                data-testid={`attachment-thumb-${id}`}
              >
                {video ? (
                  <video src={attachmentSrc(prKey, id)} muted preload="metadata" className="h-full w-full object-cover" />
                ) : (
                  <img src={attachmentSrc(prKey, id)} alt={a?.name ?? ""} className="h-full w-full object-cover" />
                )}
                <button
                  type="button"
                  className="absolute right-0.5 top-0.5 rounded-full p-0.5 opacity-0 transition-opacity group-hover/thumb:opacity-100 focus-visible:opacity-100"
                  style={{ background: "var(--bg-raised)", color: "var(--fg)", boxShadow: "0 0 0 1px var(--border-strong)" }}
                  title="Remove this image from the comment"
                  aria-label="Remove this image"
                  data-testid={`attachment-remove-${id}`}
                  onClick={() => editor.remove(id)}
                >
                  <IconClose width={8} height={8} />
                </button>
              </div>
            );
          })}
          {editor.uploading.map((name, i) => (
            <div
              key={`${name}-${i}`}
              className="flex h-14 w-14 flex-none items-center justify-center rounded"
              style={{ background: "var(--bg-inset)", border: "1px dashed var(--border-strong)", color: "var(--fg-faint)" }}
              title={`Uploading ${name}…`}
              data-testid="attachment-uploading"
            >
              <IconSpinner width={12} height={12} />
            </div>
          ))}
        </div>
      ) : null}
      {editor.error ? (
        <p className="mt-1 text-2xs leading-4" style={{ color: "var(--risk)" }} data-testid="attachment-error">
          {editor.error}
        </p>
      ) : null}
    </div>
  );
}

/** The full-surface hint while a file is dragged over an editor. */
export function DropHint({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md text-xs font-medium"
      style={{ background: "var(--accent-soft)", color: "var(--accent)", border: "1px dashed var(--accent)" }}
      data-testid="attachment-drop-hint"
    >
      Drop to attach
    </div>
  );
}

/**
 * The `AttachmentContext` value for one PR: a `purview-attachment:` reference
 * is served from the local store; a GitHub asset URL is too, when one of this
 * PR's attachments became it on push.
 */
export function useAttachmentScope(prKey: string): AttachmentScope {
  const { data: all = [] } = useAttachments(prKey);
  return useMemo(() => {
    const byId = new Map(all.map((a) => [a.id, a]));
    const byUrl = new Map(all.filter((a) => a.githubUrl).map((a) => [a.githubUrl!, a]));
    const media = (a: Attachment): LocalMedia => ({
      src: attachmentSrc(prKey, a.id),
      kind: a.mime.startsWith("video/") ? "video" : "image",
      name: a.name,
    });
    const resolve = (href: string): LocalMedia | null => {
      const id = attachmentIdOf(href);
      if (id) {
        const a = byId.get(id);
        return a ? media(a) : null;
      }
      if (isGithubAssetUrl(href)) {
        const a = byUrl.get(href);
        return a ? media(a) : null;
      }
      return null;
    };
    return { prKey, resolve };
  }, [all, prKey]);
}
