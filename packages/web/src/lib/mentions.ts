/**
 * @mentions in the chat composer: typing `@` starts a word that names a unit,
 * a file or a concept, and picking one attaches it as a ref chip.
 *
 * Pure: finding the `@word` under the caret, the candidates a PR offers, and
 * how they rank against what was typed.
 */

import type { ChatRef, PrDetail } from "../api/types";
import { baseName } from "./chatRefs";
import { unitDisplayNumbers, unitDisplayOrder } from "./unitOrder";

export interface MentionQuery {
  /** index of the `@` in the text */
  start: number;
  /** what follows the `@`, up to the caret */
  query: string;
}

/**
 * The `@query` the caret is in, if any. The `@` must start a word (start of
 * text or after whitespace), so an email address never opens the list. The
 * query may hold spaces, since titles and terms do ("@charge key"), up to a
 * newline or 40 characters; the list itself closes once nothing matches.
 */
export function mentionAt(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret);
  const m = /(?:^|\s)@((?:[^\s@][^\n@]{0,39})?)$/.exec(before);
  if (!m) return null;
  return { start: caret - m[1].length - 1, query: m[1] };
}

export interface MentionOption {
  ref: ChatRef;
  kind: "unit" | "concept" | "file";
  /** what the list shows */
  label: string;
  /** faint, after the label: a file's folder */
  hint?: string;
  /** the unit's number in the guide */
  number?: number;
  /** extra words the query may match (a concept's code names) */
  also?: string[];
}

export function mentionOptions(detail: PrDetail | undefined): MentionOption[] {
  if (!detail) return [];
  const units = unitDisplayOrder(detail.state.units ?? []);
  const numbers = unitDisplayNumbers(units);
  return [
    ...units.map((u): MentionOption => ({
      ref: { kind: "unit", id: u.id },
      kind: "unit",
      label: u.title,
      number: numbers.get(u.id),
    })),
    ...(detail.state.concepts ?? []).map((c): MentionOption => ({
      ref: { kind: "concept", id: c.term },
      kind: "concept",
      label: c.term,
      also: c.aka,
    })),
    ...detail.files.files.map((f): MentionOption => {
      const dir = f.path.slice(0, f.path.length - baseName(f.path).length).replace(/\/$/, "");
      return { ref: { kind: "file", path: f.path }, kind: "file", label: baseName(f.path), hint: dir || undefined };
    }),
  ];
}

/**
 * Rank options against the typed query: a label that starts with it, then one
 * with a word that starts with it, then one that contains it anywhere (the
 * file's folder and a concept's code names count here). An empty query keeps
 * the list's own order: units, concepts, files.
 */
export function rankMentions(options: MentionOption[], query: string, limit = 8): MentionOption[] {
  const q = query.toLowerCase();
  if (!q) return options.slice(0, limit);
  const scored: { o: MentionOption; score: number; i: number }[] = [];
  options.forEach((o, i) => {
    const label = o.label.toLowerCase();
    const number = o.number !== undefined ? String(o.number) : null;
    let score = -1;
    if (number === q) score = 4;
    else if (label.startsWith(q)) score = 3;
    else if (label.split(/[\s/._-]+/).some((w) => w.startsWith(q))) score = 2;
    else if (
      label.includes(q) ||
      (o.hint ?? "").toLowerCase().includes(q) ||
      (o.also ?? []).some((a) => a.toLowerCase().includes(q))
    )
      score = 1;
    if (score > 0) scored.push({ o, score, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, limit).map((s) => s.o);
}

/** The text with the `@query` replaced by nothing, and where the caret lands. */
export function removeMention(text: string, at: MentionQuery): { text: string; caret: number } {
  const end = at.start + 1 + at.query.length;
  const rest = text.slice(end).replace(/^ /, "");
  const head = text.slice(0, at.start);
  return { text: head + rest, caret: head.length };
}
