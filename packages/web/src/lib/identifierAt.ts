/**
 * Identifier resolution for cmd+click "go to definition" in the diff viewer.
 *
 * `wordAt` is pure (string + offset in, word or null out) and is what's
 * tested — the DOM part (`identifierAtPoint`) only has to turn a click point
 * into a text-node offset and hand it off.
 */

const WORD_CHAR = /[A-Za-z0-9_$]/;

/**
 * The identifier that a caret at `offset` into `text` sits on or against.
 * `offset` is a boundary (between `text[offset - 1]` and `text[offset]`, DOM
 * Range style), not a character index — so a caret landing right after a word
 * (its most common resting place when a click lands mid-glyph) still resolves
 * to that word, not to whatever comes after it. `null` when the caret is
 * between two non-word characters (whitespace, punctuation): there is no
 * identifier here to jump from.
 */
export function wordAt(text: string, offset: number): string | null {
  if (offset < 0 || offset > text.length) return null;
  const isWord = (i: number) => i >= 0 && i < text.length && WORD_CHAR.test(text[i]);
  if (!isWord(offset) && !isWord(offset - 1)) return null;
  let start = offset;
  while (isWord(start - 1)) start--;
  let end = offset;
  while (isWord(end)) end++;
  return start < end ? text.slice(start, end) : null;
}

/** Character offset of `(node, nodeOffset)` within `container`'s full text. */
function globalTextOffset(container: Node, node: Node, nodeOffset: number): number | null {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let cur = walker.nextNode();
  while (cur) {
    if (cur === node) return offset + nodeOffset;
    offset += (cur.textContent ?? "").length;
    cur = walker.nextNode();
  }
  return null;
}

/**
 * The identifier under a click point inside `container` — a diff line's code
 * span, whose full text is split across several `<span>` runs (syntax
 * highlighting, search marks, word-diff). `null` when the click misses text
 * entirely, or lands on a non-word character.
 *
 * `caretPositionFromPoint` is the standard API; Safari/WebKit only has the
 * older `caretRangeFromPoint`, hence the fallback.
 */
export function identifierAtPoint(
  container: HTMLElement,
  clientX: number,
  clientY: number,
): string | null {
  const doc = container.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };

  let node: Node | null = null;
  let nodeOffset = 0;
  if (typeof doc.caretPositionFromPoint === "function") {
    const pos = doc.caretPositionFromPoint(clientX, clientY);
    if (!pos) return null;
    node = pos.offsetNode;
    nodeOffset = pos.offset;
  } else if (typeof doc.caretRangeFromPoint === "function") {
    const range = doc.caretRangeFromPoint(clientX, clientY);
    if (!range) return null;
    node = range.startContainer;
    nodeOffset = range.startOffset;
  } else {
    return null;
  }

  if (!node || node.nodeType !== Node.TEXT_NODE || !container.contains(node)) return null;
  const offset = globalTextOffset(container, node, nodeOffset);
  if (offset === null) return null;
  return wordAt(container.textContent ?? "", offset);
}
