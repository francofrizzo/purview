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
  type IconProps,
} from "@tabler/icons-react";
import {
  useLayoutEffect,
  useRef,
  type ClipboardEvent,
  type ComponentType,
  type KeyboardEvent,
  type ReactNode,
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
 * The formatting buttons, the height of the Write | Preview control they sit
 * beside. Quiet at rest; each names its chord in the tooltip. Disabled while
 * previewing, since there is no selection to format. "Suggest a change" sits
 * apart at the end: it is about the code, not the prose, and it is off (with
 * the reason) wherever GitHub would refuse the suggestion.
 */
export function FormatToolbar({
  fmt,
  disabled = false,
  testId = "format",
}: {
  fmt: ComposerFormat;
  disabled?: boolean;
  testId?: string;
}) {
  const suggest = fmt.suggestion;
  const suggestLabel = FORMAT_LABELS.suggestion;
  return (
    <div role="toolbar" aria-label="Formatting" className="flex flex-none items-center gap-px">
      {TOOLS.map(({ action, Icon }) => {
        const { label, chord } = FORMAT_LABELS[action];
        return (
          <ToolButton
            key={action}
            testId={`${testId}-${action}`}
            title={chord ? `${label} (${chord})` : label}
            label={label}
            disabled={disabled}
            onClick={() => fmt.apply(action)}
          >
            <Icon size={13} stroke={2} />
          </ToolButton>
        );
      })}
      {suggest ? (
        <>
          <span aria-hidden className="mx-1 h-3 w-px flex-none" style={{ background: "var(--border)" }} />
          <ToolButton
            testId={`${testId}-suggestion`}
            title={suggest.reason ?? `${suggestLabel.label} (${suggestLabel.chord})`}
            label={suggestLabel.label}
            disabled={disabled || !suggest.lines}
            onClick={() => fmt.apply("suggestion")}
          >
            <IconFileDiff size={13} stroke={2} />
          </ToolButton>
        </>
      ) : null}
    </div>
  );
}

function ToolButton({
  testId,
  title,
  label,
  disabled,
  onClick,
  children,
}: {
  testId: string;
  title: string;
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      className="flex h-5 w-5 items-center justify-center rounded transition-colors enabled:hover:bg-[var(--bg-hover)] enabled:hover:text-[var(--fg)] disabled:opacity-40"
      style={{ color: "var(--fg-faint)" }}
      title={title}
      aria-label={label}
      disabled={disabled}
      // Keep the textarea's selection: a mousedown on the button would move focus.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
