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
  const options: { value: ComposerMode; label: string; title: string }[] = [
    { value: "write", label: "Write", title: "Edit the markdown (⌘⇧P)" },
    { value: "preview", label: "Preview", title: `Preview (⌘⇧P). ${PREVIEW_LIMITS}` },
  ];
  return (
    <div
      role="group"
      aria-label="Write or preview"
      className="inline-flex flex-none items-center rounded p-px"
      style={{ background: "var(--bg-inset)", border: "1px solid var(--border)" }}
    >
      {options.map(({ value, label, title }) => {
        const active = mode === value;
        return (
          <button
            key={value}
            type="button"
            data-testid={`${testId}-${value}`}
            aria-pressed={active}
            title={title}
            onClick={() => onChange(value)}
            className="rounded-sm px-1.5 text-2xs leading-4 transition-colors"
            style={{
              background: active ? "var(--bg-raised)" : "transparent",
              color: active ? "var(--fg)" : "var(--fg-faint)",
              boxShadow: active ? "0 0 0 1px var(--border-strong)" : undefined,
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
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
