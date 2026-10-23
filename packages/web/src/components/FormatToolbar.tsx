import {
  IconBlockquote,
  IconBold,
  IconCode,
  IconFileDiff,
  IconItalic,
  IconLink,
  IconList,
  IconListCheck,
  IconListNumbers,
  IconTypography,
  type IconProps,
} from "@tabler/icons-react";
import {
  useLayoutEffect,
  useRef,
  type ClipboardEvent,
  type ComponentType,
  type KeyboardEvent,
  type RefObject,
} from "react";
import {
  applyFormat,
  continueList,
  FORMAT_LABELS,
  formatActionFor,
  pasteUrlOverSelection,
  type EditAction,
  type FormatAction,
  type TextEdit,
} from "../lib/composerFormat";
import { insertSuggestion, type SuggestionSource } from "../lib/suggestion";

/**
 * Markdown formatting for a comment textarea: the toolbar's buttons and the
 * keyboard chords both go through `apply`, which sets the body and puts the
 * selection back where the edit says once React has rendered the new text.
 * Only meaningful in Write mode — the textarea is what carries the selection.
 */
export interface ComposerFormat {
  apply: (action: FormatAction) => void;
  /** put text at the caret (over the selection), caret after it */
  insert: (text: string) => void;
  /** "suggest a change": the lines it starts from, or why it is off; absent when the editor has no anchor */
  suggestion?: SuggestionSource;
  /** the textarea's keydown: true when the key was a formatting chord or a list Enter (and handled) */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** the textarea's paste: true when a URL was pasted over a selection (and handled) */
  onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => boolean;
}

export function useComposerFormat({
  textareaRef,
  body,
  setBody,
  suggestion,
}: {
  textareaRef: RefObject<HTMLTextAreaElement>;
  body: string;
  setBody: (next: string) => void;
  /** what a ```suggestion block here would be over (lib/suggestion.ts) */
  suggestion?: SuggestionSource;
}): ComposerFormat {
  // Where the selection goes after the pending edit lands in the textarea.
  const restore = useRef<TextEdit | null>(null);
  useLayoutEffect(() => {
    const edit = restore.current;
    const el = textareaRef.current;
    if (!edit || !el || el.value !== edit.text) return;
    restore.current = null;
    el.focus({ preventScroll: true });
    el.setSelectionRange(edit.start, edit.end);
  }, [body, textareaRef]);

  const commit = (edit: TextEdit) => {
    restore.current = edit;
    setBody(edit.text);
  };

  const selection = () => {
    const el = textareaRef.current;
    return el ? { start: el.selectionStart, end: el.selectionEnd } : { start: body.length, end: body.length };
  };

  // A suggestion is an insertion of the anchored lines, not an edit of the
  // selection; without lines (old side, whole file) the action is a no-op.
  const run = (text: string, action: FormatAction) => {
    if (action === "suggestion") {
      if (suggestion?.lines) commit(insertSuggestion(text, selection(), suggestion.lines));
      return;
    }
    commit(applyFormat(text, selection(), action as EditAction));
  };

  return {
    apply: (action) => run(body, action),
    insert: (text) => {
      const { start, end } = selection();
      const at = start + text.length;
      commit({ text: body.slice(0, start) + text + body.slice(end), start: at, end: at });
    },
    suggestion,
    onKeyDown: (e) => {
      // Enter continues a list; ⇧↵ and the ⌘↵ family (save, ask chat) are not ours.
      if (e.key === "Enter") {
        if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return false;
        const el = e.currentTarget;
        if (el.selectionStart !== el.selectionEnd) return false;
        const edit = continueList(el.value, el.selectionStart);
        if (!edit) return false;
        e.preventDefault();
        commit(edit);
        return true;
      }
      const action = formatActionFor(e);
      if (!action) return false;
      // Claimed even when it does nothing: ⌘⇧S must never reach the browser's save dialog.
      e.preventDefault();
      run(e.currentTarget.value, action);
      return true;
    },
    onPaste: (e) => {
      const pasted = e.clipboardData?.getData("text/plain") ?? "";
      const edit = pasteUrlOverSelection(e.currentTarget.value, selection(), pasted);
      if (!edit) return false;
      e.preventDefault();
      commit(edit);
      return true;
    },
  };
}

/**
 * "Suggest a change": the one formatting action worth a button, since it is
 * about the code, not the prose. A word, the height of Write | Preview, off
 * (with the reason) wherever GitHub would refuse the suggestion. Bold, lists
 * and the rest are typed as markdown or reached by their chords (see `?`).
 */
export function SuggestButton({
  fmt,
  disabled = false,
  testId = "format-suggestion",
}: {
  fmt: ComposerFormat;
  disabled?: boolean;
  testId?: string;
}) {
  const suggest = fmt.suggestion;
  if (!suggest) return null;
  const { label, chord } = FORMAT_LABELS.suggestion;
  return (
    <button
      type="button"
      data-testid={testId}
      className="inline-flex h-5 items-center gap-1 rounded px-1.5 text-2xs transition-colors enabled:hover:bg-[var(--bg-hover)] enabled:hover:text-[var(--fg)] disabled:opacity-40"
      style={{ color: "var(--fg-muted)" }}
      data-tip={suggest.reason ?? label}
      data-tip-key={suggest.reason ? undefined : (chord ?? undefined)}
      aria-label={label}
      disabled={disabled || !suggest.lines}
      // Keep the textarea's selection: a mousedown on the button would move focus.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => fmt.apply("suggestion")}
    >
      <IconFileDiff size={12} stroke={2} />
      suggest change
    </button>
  );
}

const TOOLS: { action: EditAction; Icon: ComponentType<IconProps> }[] = [
  { action: "bold", Icon: IconBold },
  { action: "italic", Icon: IconItalic },
  { action: "code", Icon: IconCode },
  { action: "link", Icon: IconLink },
  { action: "bullet", Icon: IconList },
  { action: "ordered", Icon: IconListNumbers },
  { action: "quote", Icon: IconBlockquote },
  { action: "task", Icon: IconListCheck },
];

/**
 * "Aa": opens or closes the formatting buttons. They stay out of the way
 * until asked for (markdown and the chords work either way) and the choice is
 * remembered, so whoever likes them has them every time.
 */
export function FormattingToggle({ open, onToggle, testId = "format-toggle" }: { open: boolean; onToggle: () => void; testId?: string }) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={open}
      aria-label={open ? "Hide formatting" : "Show formatting"}
      data-tip={open ? "Hide formatting" : "Show formatting: bold, lists, links…"}
      className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
      style={{ color: open ? "var(--fg)" : "var(--fg-muted)", background: open ? "var(--bg-hover)" : undefined }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onToggle}
    >
      <IconTypography size={13} stroke={2} />
    </button>
  );
}

/** The formatting buttons, each naming its chord in the tooltip; off while previewing. */
export function FormatRow({ fmt, disabled = false, testId = "format" }: { fmt: ComposerFormat; disabled?: boolean; testId?: string }) {
  return (
    <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-px">
      {TOOLS.map(({ action, Icon }) => {
        const { label, chord } = FORMAT_LABELS[action];
        return (
          <button
            key={action}
            type="button"
            data-testid={`${testId}-${action}`}
            className="flex h-5 w-5 items-center justify-center rounded transition-colors enabled:hover:bg-[var(--bg-hover)] enabled:hover:text-[var(--fg)] disabled:opacity-40"
            style={{ color: "var(--fg-faint)" }}
            data-tip={label}
            data-tip-key={chord ?? undefined}
            aria-label={label}
            disabled={disabled}
            // Keep the textarea's selection: a mousedown on the button would move focus.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => fmt.apply(action)}
          >
            <Icon size={13} stroke={2} />
          </button>
        );
      })}
    </div>
  );
}
