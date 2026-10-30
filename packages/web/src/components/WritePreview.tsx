import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import {
  isPreviewToggleKey,
  PREVIEW_LIMITS,
  rememberMode,
  rememberedMode,
  toggledMode,
  type ComposerMode,
} from "../lib/composerMode";
import { Markdown } from "./Markdown";
import { IconEdit, IconEye } from "./icons";

/**
 * Write / Preview for a comment editor. The textarea stays mounted (hidden)
 * while previewing, so its text, scroll and height survive the round trip;
 * the preview takes focus in its place, so ⌘↵ / ⌘⇧↵ / esc on the wrapper
 * keep working, and switching back hands the caret and selection back.
 */
export interface WritePreview {
  mode: ComposerMode;
  writing: boolean;
  setMode: (mode: ComposerMode) => void;
  toggle: () => void;
  /** the wrapper's keydown: true when the event was the toggle chord (and handled) */
  onKeyDown: (e: KeyboardEvent) => boolean;
  /** focus whichever of the two is showing */
  focus: () => void;
  /** the textarea's height when the preview replaced it, so the box does not jump */
  minHeight: number;
  previewRef: RefObject<HTMLDivElement>;
}

export function useWritePreview(textareaRef: RefObject<HTMLTextAreaElement>): WritePreview {
  const [mode, setModeState] = useState<ComposerMode>(rememberedMode);
  const [minHeight, setMinHeight] = useState(0);
  const previewRef = useRef<HTMLDivElement>(null);
  const selection = useRef<{ start: number; end: number } | null>(null);
  // Only a toggle moves focus; mounting in the remembered mode leaves it to the caller.
  const refocus = useRef(false);

  const focus = () => {
    if (mode === "preview") {
      previewRef.current?.focus({ preventScroll: true });
      return;
    }
    const el = textareaRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    const sel = selection.current;
    if (sel) el.setSelectionRange(sel.start, sel.end);
  };

  const setMode = (next: ComposerMode) => {
    if (next === mode) return;
    const el = textareaRef.current;
    if (next === "preview" && el) {
      selection.current = { start: el.selectionStart, end: el.selectionEnd };
      setMinHeight(el.offsetHeight);
    }
    rememberMode(next);
    refocus.current = true;
    setModeState(next);
  };

  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const toggle = () => setMode(toggledMode(mode));
  return {
    mode,
    writing: mode === "write",
    setMode,
    toggle,
    onKeyDown: (e) => {
      if (!isPreviewToggleKey(e)) return false;
      e.preventDefault();
      e.stopPropagation();
      toggle();
      return true;
    },
    focus,
    minHeight,
    previewRef,
  };
}

/** The segmented Write | Preview control, styled like the diff pane's unified / split. */
export function WritePreviewToggle({
  mode,
  onChange,
  testId = "composer-mode",
}: {
  mode: ComposerMode;
  onChange: (mode: ComposerMode) => void;
  testId?: string;
}) {
  // One button that names the way over, in a word and an icon, like
  // "suggest change" beside it: an eye and a pencil alone were guesses.
  const previewing = mode === "preview";
  const Icon = previewing ? IconEdit : IconEye;
  return (
    <button
      type="button"
      data-testid={`${testId}-${previewing ? "write" : "preview"}`}
      aria-pressed={previewing}
      data-tip={previewing ? "Back to the markdown" : `See it rendered; ${PREVIEW_LIMITS}`}
      data-tip-key="⌘⇧P"
      onClick={() => onChange(previewing ? "write" : "preview")}
      className="inline-flex h-5 flex-none items-center gap-1 rounded px-1.5 text-2xs transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
      style={{ color: previewing ? "var(--fg)" : "var(--fg-muted)", background: previewing ? "var(--bg-hover)" : undefined }}
    >
      <Icon width={12} height={12} />
      {previewing ? "edit" : "preview"}
    </button>
  );
}

/**
 * The rendered body, where the textarea was. Focusable so the editor's
 * shortcuts still have a target while nothing is being typed.
 */
export function ComposerPreview({
  body,
  wp,
  textClass,
  className = "",
  testId = "composer-preview",
}: {
  body: string;
  wp: WritePreview;
  /** the comment card's body size, so the preview reads like the result */
  textClass: string;
  className?: string;
  testId?: string;
}) {
  const empty = !body.trim();
  return (
    <div
      ref={wp.previewRef}
      tabIndex={-1}
      data-testid={testId}
      className={`outline-none ${className}`}
      style={{ minHeight: wp.minHeight || undefined, color: "var(--fg)" }}
    >
      {empty ? (
        <p className={textClass} style={{ color: "var(--fg-faint)" }}>
          Nothing to preview
        </p>
      ) : (
        <Markdown text={body} textClass={textClass} ink="var(--fg)" />
      )}
    </div>
  );
}
