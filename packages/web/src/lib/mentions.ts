/**
 * @mentions in the chat composer: typing `@` starts a word that names a unit,
 * a file or a concept, and picking one writes its token into the message
 * (`@unit 3`, `@ledger.ts`, `@Charge key`). The token is the reference: on
 * send, every token still in the text becomes a ref, so deleting the words
 * drops the ref with them and the sentence keeps its subject.
 *
 * Pure: finding the `@word` under the caret, the candidates a PR offers, how
 * they rank against what was typed, and finding tokens in a written message.
 */

import type { ChatRef, PrDetail } from "../api/types";
import { baseName, refKey } from "./chatRefs";
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
  /** what picking it writes into the message, `@` included */
  token: string;
  /** a unit's title, a file's path, a concept's meaning: the token's hover */
  tip: string;
}

export function mentionOptions(detail: PrDetail | undefined): MentionOption[] {
  if (!detail) return [];
  const units = unitDisplayOrder(detail.state.units ?? []);
  const numbers = unitDisplayNumbers(units);
  const files = detail.files.files;
  // A file goes by its name, unless another file in the PR shares it.
  const names = new Map<string, number>();
  for (const f of files) names.set(baseName(f.path), (names.get(baseName(f.path)) ?? 0) + 1);
  return [
    ...units.map((u): MentionOption => {
      const number = numbers.get(u.id);
      return {
        ref: { kind: "unit", id: u.id },
        kind: "unit",
        label: u.title,
        number,
        token: number !== undefined ? `@unit ${number}` : `@${u.title}`,
        tip: number !== undefined ? `Unit ${number}: ${u.title}` : u.title,
      };
    }),
    ...(detail.state.concepts ?? []).map((c): MentionOption => ({
      ref: { kind: "concept", id: c.term },
      kind: "concept",
      label: c.term,
      also: c.aka,
      token: `@${c.term}`,
      tip: `${c.term}: ${c.means}`,
    })),
    ...files.map((f): MentionOption => {
      const name = baseName(f.path);
      const dir = f.path.slice(0, f.path.length - name.length).replace(/\/$/, "");
      return {
        ref: { kind: "file", path: f.path },
        kind: "file",
        label: name,
        hint: dir || undefined,
        token: `@${(names.get(name) ?? 0) > 1 ? f.path : name}`,
        tip: f.path,
      };
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

/** The text with the `@query` replaced by the option's token and a space, and where the caret lands. */
export function insertMention(text: string, at: MentionQuery, token: string): { text: string; caret: number } {
  const end = at.start + 1 + at.query.length;
  const rest = text.slice(end).replace(/^ /, "");
  const head = `${text.slice(0, at.start)}${token} `;
  return { text: head + rest, caret: head.length };
}

export interface MentionSpan {
  start: number;
  end: number;
  option: MentionOption;
}

/**
 * The tokens written in a message, in order. A token starts a word and ends
 * where a word would (`@unit 3` is not in `@unit 30`); the longest token wins
 * where two start alike. Case is forgiven, since people retype them.
 */
export function findMentions(text: string, options: readonly MentionOption[]): MentionSpan[] {
  if (!options.length || !text.includes("@")) return [];
  const byLength = [...options].sort((a, b) => b.token.length - a.token.length);
  const lower = text.toLowerCase();
  const spans: MentionSpan[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "@" || (i > 0 && !/\s|[(["']/.test(text[i - 1]))) continue;
    const hit = byLength.find((o) => {
      if (!lower.startsWith(o.token.toLowerCase(), i)) return false;
      const next = text[i + o.token.length];
      return next === undefined || !/[\w-]/.test(next);
    });
    if (!hit) continue;
    spans.push({ start: i, end: i + hit.token.length, option: hit });
    i += hit.token.length - 1;
  }
  return spans;
}

/** The refs a message's tokens name, once each, in the order written. */
export function mentionRefs(text: string, options: readonly MentionOption[]): ChatRef[] {
  const seen = new Set<string>();
  const refs: ChatRef[] = [];
  for (const { option } of findMentions(text, options)) {
    const key = refKey(option.ref);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(option.ref);
  }
  return refs;
}
