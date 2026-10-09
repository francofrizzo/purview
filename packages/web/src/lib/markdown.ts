/**
 * A small markdown subset, enough for assistant replies: paragraphs, ATX
 * headings, fenced code, blockquotes, bullet/ordered lists, thematic breaks,
 * pipe tables, and inline code / emphasis / links.
 *
 * It is written for *streaming*: the source is re-parsed on every delta, and a
 * fence that has not been closed yet still yields a code block (marked `open`)
 * so a half-arrived snippet renders as code rather than as prose. Nothing here
 * touches the DOM — rendering lives in components/Markdown.tsx.
 */

export type MdBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "code"; lang: string | null; code: string; open: boolean }
  | { type: "list"; ordered: boolean; items: string[] }
  /** `text` is the quote's source, flattened; `blocks` is it parsed as markdown. */
  | { type: "quote"; text: string; blocks: MdBlock[] }
  | { type: "hr" }
  | { type: "table"; align: TableAlign[]; header: string[]; rows: string[][] }
  /** GitHub's `<details><summary>…</summary>…</details>`: a collapsible. */
  | { type: "details"; summary: string; open: boolean; blocks: MdBlock[] };

export type TableAlign = "left" | "center" | "right" | null;

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
/** The `| --- | :-: |` row under a table header; every cell is dashes with optional colons. */
const TABLE_SEP = /^\s{0,3}\|?(\s*:?-+:?\s*\|)*\s*:?-+:?\s*\|?\s*$/;

/** Split a table row into trimmed cells; `\|` inside a cell stays a literal pipe. */
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, "|").trim());
}

/** A header row is only a table once its separator row has arrived — until
 *  then (mid-stream) it is a paragraph, which is the right thing to show. */
function isTableStart(lines: string[], i: number): boolean {
  const header = lines[i];
  const sep = lines[i + 1];
  if (!header || !sep || !header.includes("|") || !TABLE_SEP.test(sep) || !sep.includes("|")) {
    return false;
  }
  return splitTableRow(sep).length === splitTableRow(header).length;
}

function tableAlign(cell: string): TableAlign {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

const DETAILS_OPEN = /^\s*<details(\s[^>]*)?>/i;
const DETAILS_TAG = /<(\/?)details(\s[^>]*)?>/gi;

/**
 * A `<details>` block starting at `lines[start]`: its summary, body source,
 * `open` flag and the index of the line to resume at. Nested `<details>` are
 * balanced; an unclosed one runs to the end of the text, as on GitHub. Text
 * left on the closing line after `</details>` is put back and resumed there.
 */
function readDetails(lines: string[], start: number): { summary: string; body: string; open: boolean; next: number } {
  const text = lines.slice(start).join("\n");
  const first = DETAILS_OPEN.exec(text)!;
  const open = /\bopen\b/i.test(first[1] ?? "");
  let depth = 0;
  let end = text.length;
  let after = text.length;
  DETAILS_TAG.lastIndex = 0;
  for (let m; (m = DETAILS_TAG.exec(text)); ) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) {
      end = m.index;
      after = m.index + m[0].length;
      break;
    }
  }
  let inner = text.slice(first.index + first[0].length, end);
  let summary = "Details";
  const sum = /^\s*<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary>/i.exec(inner);
  if (sum) {
    summary = sum[1].replace(/\s+/g, " ").trim() || summary;
    inner = inner.slice(sum.index + sum[0].length);
  }
  const lastLine = start + text.slice(0, after).split("\n").length - 1;
  const tail = text.slice(after).split("\n")[0] ?? "";
  if (tail.trim()) {
    lines[lastLine] = tail;
    return { summary, body: inner, open, next: lastLine };
  }
  return { summary, body: inner, open, next: lastLine + 1 };
}

export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    if (DETAILS_OPEN.test(line)) {
      const d = readDetails(lines, i);
      blocks.push({ type: "details", summary: d.summary, open: d.open, blocks: parseMarkdown(d.body) });
      i = d.next;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const len = fence[1].length;
      const lang = fence[2] ? fence[2].toLowerCase() : null;
      const body: string[] = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        const close = FENCE.exec(lines[i]);
        if (close && close[1][0] === marker && close[1].length >= len && !close[2]) {
          closed = true;
          i++;
          break;
        }
        body.push(lines[i]);
        i++;
      }
      blocks.push({ type: "code", lang, code: body.join("\n"), open: !closed });
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length,
        text: heading[2].replace(/\s+#+\s*$/, "").trim(),
      });
      i++;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      // Quoted lines keep their own line structure, so a quote (or a GitHub
      // alert) can hold headings, lists and `<details>` like any other text.
      const parts = [quote[1]];
      i++;
      while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i])) {
        const cont = QUOTE.exec(lines[i]);
        parts.push(cont ? cont[1] : lines[i].trim());
        i++;
      }
      blocks.push({
        type: "quote",
        text: parts.join(" ").trim(),
        blocks: parseMarkdown(parts.join("\n")),
      });
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = !BULLET.test(line);
      const items: string[] = [];
      while (i < lines.length) {
        const b = BULLET.exec(lines[i]);
        const o = ORDERED.exec(lines[i]);
        const isItem = ordered ? Boolean(o) : Boolean(b);
        if (isItem) {
          items.push((ordered ? o![2] : b![1]).trim());
          i++;
          continue;
        }
        // A plain indented line continues the previous item.
        if (items.length && lines[i].trim() && /^\s{2,}/.test(lines[i]) && !FENCE.test(lines[i])) {
          items[items.length - 1] += ` ${lines[i].trim()}`;
          i++;
          continue;
        }
        break;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    if (isTableStart(lines, i)) {
      const header = splitTableRow(lines[i]);
      const align = splitTableRow(lines[i + 1]).map(tableAlign);
      const rows: string[][] = [];
      i += 2;
      // The body runs until a blank line or another block; ragged rows are
      // squared to the header so the renderer never sees a jagged grid.
      while (
        i < lines.length &&
        lines[i].trim() &&
        lines[i].includes("|") &&
        !FENCE.test(lines[i]) &&
        !HEADING.test(lines[i]) &&
        !HR.test(lines[i])
      ) {
        const cells = splitTableRow(lines[i]).slice(0, header.length);
        while (cells.length < header.length) cells.push("");
        rows.push(cells);
        i++;
      }
      blocks.push({ type: "table", align, header, rows });
      continue;
    }

    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      if (
        !next.trim() ||
        FENCE.test(next) ||
        HEADING.test(next) ||
        BULLET.test(next) ||
        ORDERED.test(next) ||
        QUOTE.test(next) ||
        HR.test(next) ||
        DETAILS_OPEN.test(next) ||
        isTableStart(lines, i)
      ) {
        break;
      }
      para.push(next.trim());
      i++;
    }
    blocks.push({ type: "paragraph", text: para.join(" ") });
  }

  return blocks;
}

export type MdInline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; text: string }
  | { type: "em"; text: string }
  | { type: "link"; text: string; href: string }
  /** GitHub extras: ~~strike~~ and the inline HTML its sanitizer lets through. */
  | { type: "del" | "ins" | "kbd" | "sub" | "sup" | "mark"; text: string }
  | { type: "br" }
  | { type: "image"; alt: string; href: string };

// Code first: backticks win over emphasis, as in real markdown. An image is
// a link with a `!` in front, matched before the link so the `!` is not text.
const INLINE =
  /(`+)([\s\S]*?)\1|!\[((?:[^\]\\\n]|\\.)*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(\*\*|__)([\s\S]+?)\7|(\*|_)([^\s][\s\S]*?)\9|(https?:\/\/[^\s<>()]+)/;

/**
 * ~~strike~~ plus the inline HTML GitHub renders. Anything not listed here
 * stays literal text: prose is full of `Promise<void>`-style angle brackets
 * that are not tags at all.
 */
const HTML_INLINE =
  /~~(?!~)([\s\S]+?)~~|<br\s*\/?>|<img\b([^>]*)>|<a\s[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>|<(kbd|sub|sup|b|strong|i|em|code|del|s|strike|ins|mark|u|tt|var|samp)(?:\s[^>]*)?>([\s\S]*?)<\/\5\s*>/i;

const TAG_TYPE: Record<string, MdInline["type"]> = {
  b: "strong",
  strong: "strong",
  i: "em",
  em: "em",
  code: "code",
  tt: "code",
  samp: "code",
  var: "em",
  del: "del",
  s: "del",
  strike: "del",
  ins: "ins",
  u: "ins",
  mark: "mark",
  kbd: "kbd",
  sub: "sub",
  sup: "sup",
};

const attr = (attrs: string, name: string) =>
  new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(attrs)?.[1];

/** Inner text of an inline tag: nested tags dropped, whitespace collapsed. */
const tagText = (inner: string) => inner.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");

function htmlNode(h: RegExpExecArray): MdInline {
  if (h[1] !== undefined) return { type: "del", text: h[1] };
  if (h[0].toLowerCase().startsWith("<br")) return { type: "br" };
  if (h[2] !== undefined) {
    return { type: "image", alt: attr(h[2], "alt") ?? "", href: attr(h[2], "src") ?? "" };
  }
  if (h[3] !== undefined) {
    // A linked badge or banner: its image's alt text is the link's name.
    const alt = /<img\b[^>]*\balt\s*=\s*["']([^"']+)["']/i.exec(h[4])?.[1];
    return { type: "link", text: tagText(h[4]).trim() || alt || h[3], href: h[3] };
  }
  const type = TAG_TYPE[h[5].toLowerCase()];
  return { type, text: tagText(h[6]) } as MdInline;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Underscores only delimit emphasis at word boundaries (as in CommonMark), so
 * `get_balance` and `snake_case_names` stay literal. `*` has no such rule.
 */
function intrawordUnderscore(src: string, start: number, end: number, delim: string): boolean {
  if (delim[0] !== "_") return false;
  return WORD_CHAR.test(src[start - 1] ?? "") || WORD_CHAR.test(src[end] ?? "");
}

/**
 * HTML that only carries layout on GitHub: wrapper tags whose content is
 * already plain text, and the light-theme twin of a themed banner (GitHub
 * shows `#gh-light-mode-only` or `#gh-dark-mode-only` by theme; side by side
 * they read as the same link twice). The dark twin stays, as one link.
 */
const LAYOUT_HTML =
  /<\/?(?:p|div|span|picture|center)(?:\s[^>]*)?>|<source\b[^>]*>|<a\s[^>]*#gh-light-mode-only[^>]*>[\s\S]*?<\/a\s*>|!\[[^\]]*\]\([^)\s]*#gh-light-mode-only\)|<img\b[^>]*#gh-light-mode-only[^>]*>|#gh-dark-mode-only/gi;

export function parseInline(src: string): MdInline[] {
  const out: MdInline[] = [];
  let rest = src.replace(LAYOUT_HTML, "");

  while (rest) {
    const m = INLINE.exec(rest);
    // A tag or ~~strike~~ that starts before the next markdown token wins;
    // a code span that starts first keeps any tag inside it literal.
    const h = HTML_INLINE.exec(rest);
    if (h && (!m || h.index < m.index)) {
      if (h.index > 0) out.push({ type: "text", text: rest.slice(0, h.index) });
      out.push(htmlNode(h));
      rest = rest.slice(h.index + h[0].length);
      continue;
    }
    if (!m || m.index === undefined) break;
    const at = src.length - rest.length + m.index;
    const delim = m[7] ?? m[9];
    if (delim && intrawordUnderscore(src, at, at + m[0].length, delim)) {
      // Not emphasis: keep the delimiter as text and look again after it.
      out.push({ type: "text", text: rest.slice(0, m.index + delim.length) });
      rest = rest.slice(m.index + delim.length);
      continue;
    }
    if (m.index > 0) out.push({ type: "text", text: rest.slice(0, m.index) });
    if (m[1]) {
      // Exactly one space of padding is decoration, not content.
      out.push({ type: "code", text: m[2].replace(/^ (.*) $/, "$1") });
    } else if (m[4]) {
      // `\]` in alt text is an escaped bracket (see lib/attachments.ts).
      out.push({ type: "image", alt: m[3].replace(/\\([\\\[\]])/g, "$1"), href: m[4] });
    } else if (m[6]) {
      out.push({ type: "link", text: m[5] || m[6], href: m[6] });
    } else if (m[7]) {
      out.push({ type: "strong", text: m[8] });
    } else if (m[9]) {
      out.push({ type: "em", text: m[10] });
    } else if (m[11]) {
      out.push({ type: "link", text: m[11], href: m[11] });
    }
    rest = rest.slice(m.index + m[0].length);
  }

  if (rest) out.push({ type: "text", text: rest });
  // Merge the text runs the underscore fallback splits apart.
  const merged: MdInline[] = [];
  for (const n of out) {
    const last = merged[merged.length - 1];
    if (n.type === "text" && last?.type === "text") last.text += n.text;
    else if (n.type !== "text" || n.text.length > 0) merged.push({ ...n });
  }
  return merged;
}
