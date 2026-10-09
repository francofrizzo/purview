/**
 * Markdown formatting in the comment editors: the pure text edits behind the
 * toolbar and the ⌘B / ⌘I / ⌘E / ⌘K / ⌘⇧7 / ⌘⇧8 / ⌘⇧. chords (GitHub's), plus
 * list continuation on Enter and "paste a URL over a selection makes a link".
 * Each edit returns the whole text and where the selection should land, so the
 * textarea can be set and have its caret restored in one go.
 */

export interface Selection {
  start: number;
  end: number;
}

export interface TextEdit {
  text: string;
  /** the selection (or caret, when start === end) after the edit */
  start: number;
  end: number;
}

export type FormatAction =
  | "bold"
  | "italic"
  | "code"
  | "link"
  | "bullet"
  | "ordered"
  | "quote"
  | "task"
  /** a ```suggestion block over the commented lines (lib/suggestion.ts); needs those lines, so not an {@link applyFormat} edit */
  | "suggestion";

/** The actions that are a pure edit of the text: everything but a suggestion. */
export type EditAction = Exclude<FormatAction, "suggestion">;

export type LinePrefixKind = Extract<FormatAction, "bullet" | "ordered" | "quote" | "task">;

/** The placeholder ⌘K writes where the address goes. */
export const LINK_PLACEHOLDER = "url";

/* ------------------------------------------------------------ inline marks */

/**
 * Wrap the selection in `before` … `after` (bold, italic, inline code), or
 * unwrap it when it already is — selected markers included or just outside the
 * selection. The selection stays on the same words either way; with nothing
 * selected the markers go in with the caret between them.
 */
export function wrapSelection(text: string, sel: Selection, before: string, after = before): TextEdit {
  const { start, end } = ordered(sel);
  const picked = text.slice(start, end);
  // The markers are inside the selection: "**bold**" selected whole.
  if (
    picked.length >= before.length + after.length &&
    picked.startsWith(before) &&
    picked.endsWith(after)
  ) {
    const inner = picked.slice(before.length, picked.length - after.length);
    return { text: text.slice(0, start) + inner + text.slice(end), start, end: start + inner.length };
  }
  // The markers hug the selection: "bold" selected inside "**bold**".
  if (text.slice(start - before.length, start) === before && text.slice(end, end + after.length) === after) {
    const from = start - before.length;
    return {
      text: text.slice(0, from) + picked + text.slice(end + after.length),
      start: from,
      end: from + picked.length,
    };
  }
  return {
    text: text.slice(0, start) + before + picked + after + text.slice(end),
    start: start + before.length,
    end: start + before.length + picked.length,
  };
}

/* ------------------------------------------------------------ links */

const LINK_RE = /^\[([^\]]*)\]\(([^)]*)\)$/;

/**
 * ⌘K. A selection becomes `[selection](url)` with the placeholder selected,
 * so typing replaces it; nothing selected inserts `[](url)` with the caret in
 * the brackets. A selected link is unwrapped back to its text.
 */
export function linkify(text: string, sel: Selection, url = LINK_PLACEHOLDER): TextEdit {
  const { start, end } = ordered(sel);
  const picked = text.slice(start, end);
  const link = LINK_RE.exec(picked);
  if (link) {
    const label = link[1];
    return { text: text.slice(0, start) + label + text.slice(end), start, end: start + label.length };
  }
  const out = `[${picked}](${url})`;
  const next = text.slice(0, start) + out + text.slice(end);
  if (picked === "") return { text: next, start: start + 1, end: start + 1 };
  const urlAt = start + picked.length + 3;
  return { text: next, start: urlAt, end: urlAt + url.length };
}

const URL_RE = /^https?:\/\/\S+$/i;

/**
 * Pasting a URL while words are selected links those words to it, instead of
 * replacing them. Null when the paste is not a lone URL, nothing is selected,
 * or the selection is itself a URL (then the paste means replace).
 */
export function pasteUrlOverSelection(text: string, sel: Selection, pasted: string): TextEdit | null {
  const { start, end } = ordered(sel);
  if (start === end) return null;
  const url = pasted.trim();
  if (!URL_RE.test(url) || /\s/.test(url)) return null;
  const picked = text.slice(start, end);
  if (URL_RE.test(picked.trim())) return null;
  const out = `[${picked}](${url})`;
  const caret = start + out.length;
  return { text: text.slice(0, start) + out + text.slice(end), start: caret, end: caret };
}

/* ------------------------------------------------------------ line prefixes */

const PREFIX_RE: Record<LinePrefixKind, RegExp> = {
  task: /^(\s*)[-*+] \[[ xX]\] /,
  bullet: /^(\s*)[-*+] (?!\[[ xX]\] )/,
  ordered: /^(\s*)\d+[.)] /,
  quote: /^(\s*)> /,
};

// Any list marker, so toggling one list kind onto another replaces it.
const LIST_MARKER_RE = /^(\s*)(?:[-*+] (?:\[[ xX]\] )?|\d+[.)] )/;

function prefixFor(kind: LinePrefixKind, n: number): string {
  switch (kind) {
    case "bullet":
      return "- ";
    case "task":
      return "- [ ] ";
    case "ordered":
      return `${n}. `;
    case "quote":
      return "> ";
  }
}

/**
 * Toggle a list or quote marker on every line the selection touches. Off when
 * each line already carries this kind, on otherwise — swapping in for another
 * list marker rather than stacking. The selection grows to the whole lines,
 * except a bare caret, which stays on its character.
 */
export function toggleLinePrefix(text: string, sel: Selection, kind: LinePrefixKind): TextEdit {
  const { start, end } = ordered(sel);
  const from = text.lastIndexOf("\n", start - 1) + 1;
  // A selection ending right after a newline does not reach the next line.
  const toBreak = text.indexOf("\n", end > start ? end - 1 : end);
  const to = toBreak === -1 ? text.length : toBreak;
  const lines = text.slice(from, to).split("\n");
  const re = PREFIX_RE[kind];
  const allOn = lines.every((l) => re.test(l));

  let caret = start;
  let lineAt = from;
  let n = 0;
  const next = lines.map((line) => {
    const indent = /^\s*/.exec(line)![0];
    // What comes off the line and what goes on, both just after the indent.
    let oldMarker = "";
    let newMarker = "";
    if (allOn) {
      oldMarker = re.exec(line)![0].slice(indent.length);
    } else if (kind === "quote") {
      if (!re.test(line)) newMarker = prefixFor(kind, 0);
    } else {
      n += 1;
      const list = LIST_MARKER_RE.exec(line);
      oldMarker = list ? list[0].slice(indent.length) : "";
      newMarker = prefixFor(kind, n);
    }
    const content = line.slice(indent.length + oldMarker.length);
    const out = indent + newMarker + content;
    if (start === end && start >= lineAt && start <= lineAt + line.length) {
      const oldContent = lineAt + indent.length + oldMarker.length;
      const newContent = lineAt + indent.length + newMarker.length;
      caret = start >= oldContent ? newContent + (start - oldContent) : newContent;
    }
    lineAt += line.length + 1;
    return out;
  });
  const joined = next.join("\n");
  const result = text.slice(0, from) + joined + text.slice(to);
  if (start === end) return { text: result, start: caret, end: caret };
  return { text: result, start: from, end: from + joined.length };
}

/* ------------------------------------------------------------ Enter in a list */

const ITEM_RE = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/;

/**
 * Enter on a list item. The next line gets the same marker (the next number
 * for an ordered list, an unticked box for a task); Enter on an empty item
 * ends the list instead, taking the marker off. Text after the caret moves
 * onto the new item. Null when the caret is not on an item, or sits inside
 * the marker itself: then Enter is just a newline.
 */
export function continueList(text: string, caret: number): TextEdit | null {
  const from = text.lastIndexOf("\n", caret - 1) + 1;
  const toBreak = text.indexOf("\n", caret);
  const to = toBreak === -1 ? text.length : toBreak;
  const line = text.slice(from, to);
  const m = ITEM_RE.exec(line);
  if (!m) return null;
  const marker = m[0];
  if (caret < from + marker.length) return null;
  const content = line.slice(marker.length);
  if (content.trim() === "") {
    // An empty item: leave the list.
    const indent = m[1];
    return { text: text.slice(0, from) + indent + text.slice(to), start: from + indent.length, end: from + indent.length };
  }
  const nextMarker = m[3]
    ? `${m[1]}${Number(m[3]) + 1}${m[4]}${m[5]}`
    : `${m[1]}${m[2]}${m[5]}${m[6] ? "[ ] " : ""}`;
  const inserted = `\n${nextMarker}`;
  const at = caret + inserted.length;
  return { text: text.slice(0, caret) + inserted + text.slice(caret), start: at, end: at };
}

/* ------------------------------------------------------------ chords */

export interface FormatKey {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Which formatting a keystroke asks for, if any. ⌘ (Ctrl elsewhere) with
 * B / I / E / K; with ⇧ as well, 7 ordered, 8 bullet, . quote, S suggestion —
 * matched on the physical key, since ⇧7 arrives as "&" on most layouts. Alt
 * chords, ⌘⇧P (preview), ⌘↵ and ⌘F are not ours.
 */
export function formatActionFor(e: FormatKey): FormatAction | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (e.shiftKey) {
    if (e.code === "Digit7" || key === "7" || key === "&") return "ordered";
    if (e.code === "Digit8" || key === "8" || key === "*") return "bullet";
    if (e.code === "Period" || key === "." || key === ">") return "quote";
    if (e.code === "KeyS" || key === "s") return "suggestion";
    return null;
  }
  switch (key) {
    case "b":
      return "bold";
    case "i":
      return "italic";
    case "e":
      return "code";
    case "k":
      return "link";
    default:
      return null;
  }
}

/** One formatting action against a text and selection. */
export function applyFormat(text: string, sel: Selection, action: EditAction): TextEdit {
  switch (action) {
    case "bold":
      return wrapSelection(text, sel, "**");
    case "italic":
      return wrapSelection(text, sel, "_");
    case "code":
      return wrapSelection(text, sel, "`");
    case "link":
      return linkify(text, sel);
    case "bullet":
    case "ordered":
    case "quote":
    case "task":
      return toggleLinePrefix(text, sel, action);
  }
}

export const FORMAT_LABELS: Record<FormatAction, { label: string; chord: string | null }> = {
  bold: { label: "Bold", chord: "⌘B" },
  italic: { label: "Italic", chord: "⌘I" },
  code: { label: "Code", chord: "⌘E" },
  link: { label: "Link", chord: "⌘K" },
  bullet: { label: "Bullet list", chord: "⌘⇧8" },
  ordered: { label: "Numbered list", chord: "⌘⇧7" },
  quote: { label: "Quote", chord: "⌘⇧." },
  task: { label: "Task list", chord: null },
  suggestion: { label: "Suggest a change", chord: "⌘⇧S" },
};

function ordered(sel: Selection): Selection {
  return sel.start <= sel.end ? sel : { start: sel.end, end: sel.start };
}
