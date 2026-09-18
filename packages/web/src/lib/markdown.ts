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
  | { type: "quote"; text: string }
  | { type: "hr" }
  | { type: "table"; align: TableAlign[]; header: string[]; rows: string[][] };

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
      const parts = [quote[1]];
      i++;
      while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i])) {
        const cont = QUOTE.exec(lines[i]);
        parts.push(cont ? cont[1] : lines[i].trim());
        i++;
      }
      blocks.push({ type: "quote", text: parts.join(" ").trim() });
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
  | { type: "link"; text: string; href: string };

// Code first: backticks win over emphasis, as in real markdown.
const INLINE =
  /(`+)([\s\S]*?)\1|\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(\*\*|__)([\s\S]+?)\5|(\*|_)([^\s][\s\S]*?)\7|(https?:\/\/[^\s<>()]+)/;

export function parseInline(src: string): MdInline[] {
  const out: MdInline[] = [];
  let rest = src;

  while (rest) {
    const m = INLINE.exec(rest);
    if (!m || m.index === undefined) break;
    if (m.index > 0) out.push({ type: "text", text: rest.slice(0, m.index) });
    if (m[1]) {
      // Exactly one space of padding is decoration, not content.
      out.push({ type: "code", text: m[2].replace(/^ (.*) $/, "$1") });
    } else if (m[4]) {
      out.push({ type: "link", text: m[3] || m[4], href: m[4] });
    } else if (m[5]) {
      out.push({ type: "strong", text: m[6] });
    } else if (m[7]) {
      out.push({ type: "em", text: m[8] });
    } else if (m[9]) {
      out.push({ type: "link", text: m[9], href: m[9] });
    }
    rest = rest.slice(m.index + m[0].length);
  }

  if (rest) out.push({ type: "text", text: rest });
  return out.filter((n) => n.type !== "text" || n.text.length > 0);
}
