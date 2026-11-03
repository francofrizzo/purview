import type { FileDiff } from "./schemas.js";

/**
 * Which hunks change nothing but names: every removed line pairs with an
 * added one that is the same token for token, except identifiers swapped
 * A→B, and the swap holds across the PR. Unlike `imp` this is a hint, not a
 * skip: a name can be data (a field serialized by name, a route), so the
 * analysis still decides. What it saves is the check the analysis cannot
 * cheaply make, that the rename was applied everywhere.
 *
 * Precision first, from the diff alone: a swap counts only when A appears on
 * no line of the PR's new side (added or context) and B on no line of its
 * old side (removed or context), A always becomes the same B, and every
 * removed line naming A and every added line naming B is one of these
 * swapped pairs. That last rule is what tells a rename from a replacement:
 * when B is a different thing taking A's place, A's old declaration or B's
 * new one is a line that does not pair, and the swap is out. A changed
 * string literal, number or punctuation, a reindented line, or an unpaired
 * line rules the hunk out. Comment text and prose files (Markdown, text) are
 * words, so a rename carried into a comment or a doc still counts; inside a
 * code string it never does (that is where persisted values live).
 */

type Tok = { kind: "id" | "str" | "other"; text: string };

const PROSE_PATH = /\.(md|mdx|markdown|txt|rst|adoc)$/i;
const IDENT = /[A-Za-z_$][\w$]*/y;

function tokenize(line: string, prose: boolean): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (!prose) {
      const marker =
        ["//", "/*", "<!--"].find((m) => line.startsWith(m, i)) ??
        ((c === "#" && (i === 0 || /\s/.test(line[i - 1]))) || (c === "*" && line.slice(0, i).trim() === "")
          ? c
          : undefined);
      if (marker) {
        out.push({ kind: "other", text: marker });
        i += marker.length;
        prose = true;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        let j = i + 1;
        while (j < line.length && line[j] !== c) j += line[j] === "\\" ? 2 : 1;
        out.push({ kind: "str", text: line.slice(i, j + 1) });
        i = j + 1;
        continue;
      }
    }
    IDENT.lastIndex = i;
    const m = IDENT.exec(line);
    if (m) {
      out.push({ kind: "id", text: m[0] });
      i += m[0].length;
      continue;
    }
    out.push({ kind: "other", text: c });
    i++;
  }
  return out;
}

/** The identifier swaps that turn `before` into `after`, or null if anything else differs. */
function lineSwaps(before: string, after: string, prose: boolean): [string, string][] | null {
  const a = tokenize(before, prose);
  const b = tokenize(after, prose);
  if (a.length !== b.length) return null;
  const swaps: [string, string][] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i].kind !== b[i].kind) return null;
    if (a[i].text === b[i].text) continue;
    if (a[i].kind !== "id") return null;
    swaps.push([a[i].text, b[i].text]);
  }
  return swaps.length > 0 ? swaps : null;
}

/** A hunk's swaps, pairing each run of removed lines with the added run after it. */
function hunkSwaps(text: string, prose: boolean): [string, string][] | null {
  const swaps: [string, string][] = [];
  let minus: string[] = [];
  let plus: string[] = [];
  const flush = (): boolean => {
    if (minus.length !== plus.length) return false;
    for (let i = 0; i < minus.length; i++) {
      const s = lineSwaps(minus[i], plus[i], prose);
      if (!s) return false;
      swaps.push(...s);
    }
    minus = [];
    plus = [];
    return true;
  };
  for (const raw of text.split("\n")) {
    const sign = raw[0];
    if (sign === "-") {
      if (plus.length > 0 && !flush()) return null;
      minus.push(raw.slice(1));
    } else if (sign === "+") {
      plus.push(raw.slice(1));
    } else if (sign !== "\\" && !flush()) {
      return null;
    }
  }
  if (!flush()) return null;
  return swaps.length > 0 ? swaps : null;
}

/** `fooBarBaz` → `["foo", "Bar", "Baz"]`, `a_b` → `["a", "_", "b"]`. */
const words = (id: string) => id.split(/(?<=[a-z0-9])(?=[A-Z])|(?=_)|(?<=_)/);

/** The part of a swap that changed, at word boundaries: `newUniversalChatbot→newContactlessChatbot` is `Universal→Contactless`. */
function core([from, to]: [string, string]): string {
  const a = words(from);
  const b = words(to);
  let p = 0;
  while (p < a.length - 1 && p < b.length - 1 && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p - 1 && s < b.length - p - 1 && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return `${a.slice(p, a.length - s).join("")}→${b.slice(p, b.length - s).join("")}`;
}

/** What a `ren` tag on a hunk means, said wherever the tag is shown. */
export const RENAME_HINT =
  "only names changed, and the diff shows the rename whole: every line naming A on the old side and B on the new one is this swap (a skip unless the name is data)";

/**
 * The revision's rename-only hunks, each with the hint naming its swaps
 * (`Universal→Contactless`, at most two, then `+N`). Generated and binary
 * files are left out, as they are of the analysis.
 */
export function renameOnlyHunks(files: FileDiff[]): Map<string, string> {
  const live = files.filter((f) => !f.generated && !f.binary);
  const newSide = new Set<string>();
  const oldSide = new Set<string>();
  const removed = new Map<string, number>();
  const added = new Map<string, number>();
  const bump = (m: Map<string, number>, w: string) => m.set(w, (m.get(w) ?? 0) + 1);
  const candidates: { id: string; swaps: [string, string][] }[] = [];
  for (const f of live) {
    const prose = PROSE_PATH.test(f.path);
    for (const h of f.hunks) {
      for (const raw of h.text.split("\n")) {
        const sign = raw[0];
        // Names as code or prose uses them; a code string is a value, read on its own.
        const found = tokenize(raw.slice(1), prose).flatMap((t) => (t.kind === "id" ? [t.text] : []));
        if (sign !== "-") for (const w of found) newSide.add(w);
        if (sign !== "+") for (const w of found) oldSide.add(w);
        if (sign === "-") for (const w of found) bump(removed, w);
        if (sign === "+") for (const w of found) bump(added, w);
      }
      const swaps = hunkSwaps(h.text, prose);
      if (swaps) candidates.push({ id: h.id, swaps });
    }
  }
  // Every A becomes one B and every B comes from one A, across the PR.
  const to = new Map<string, Set<string>>();
  const from = new Map<string, Set<string>>();
  for (const { swaps } of candidates) {
    for (const [a, b] of swaps) {
      to.set(a, (to.get(a) ?? new Set()).add(b));
      from.set(b, (from.get(b) ?? new Set()).add(a));
    }
  }
  const holds = ([a, b]: [string, string]) =>
    !newSide.has(a) && !oldSide.has(b) && to.get(a)!.size === 1 && from.get(b)!.size === 1;
  // Then every occurrence of A on the old side, and of B on the new, has to
  // be one of the kept swaps; dropping a hunk can strand another, so repeat.
  let kept = candidates.filter((c) => c.swaps.every(holds));
  for (let changed = true; changed; ) {
    const swappedA = new Map<string, number>();
    const swappedB = new Map<string, number>();
    for (const { swaps } of kept) for (const [a, b] of swaps) bump(swappedA, a), bump(swappedB, b);
    const whole = ([a, b]: [string, string]) => swappedA.get(a) === removed.get(a) && swappedB.get(b) === added.get(b);
    const next = kept.filter((c) => c.swaps.every(whole));
    changed = next.length !== kept.length;
    kept = next;
  }
  const out = new Map<string, string>();
  for (const { id, swaps } of kept) {
    const cores: string[] = [];
    for (const c of swaps.map(core)) if (!cores.some((k) => k.toLowerCase() === c.toLowerCase())) cores.push(c);
    out.set(id, cores.slice(0, 2).join(", ") + (cores.length > 2 ? ` +${cores.length - 2}` : ""));
  }
  return out;
}

/**
 * The read units that are mostly renames, said back to the analysis when it
 * saves: renames are a skip unit, and the few hunks of substance that made
 * it read belong elsewhere. A hunk counts as a rename when triage tagged it
 * `ren` or the analysis's own label says so ("rename A→B", "follows
 * rename"): the tag misses a rename the diff cannot show whole. A unit with
 * a heart is left alone: its logic lives there, and its renames are hunk
 * skips. A nudge, not a refusal: the analysis may have a reason (a name that
 * is data).
 */
export function renameUnitWarnings(
  units: { id: string; attention: string; hunks: { id: string; label?: string; heart?: unknown[] }[] }[],
  renames: Map<string, string>,
): string[] {
  const out: string[] = [];
  const isRename = (h: { id: string; label?: string }) => renames.has(h.id) || /\brenam/i.test(h.label ?? "");
  for (const u of units) {
    if (u.attention === "skip" || u.hunks.some((h) => (h.heart?.length ?? 0) > 0)) continue;
    const renamed = u.hunks.filter(isRename);
    if (renamed.length < 5 || renamed.length * 2 < u.hunks.length) continue;
    const others = u.hunks.filter((h) => !isRename(h)).map((h) => h.id.slice(0, 8));
    out.push(
      `warning: unit ${u.id} is mostly renames (${renamed.length} of ${u.hunks.length} hunks tagged ren or labelled as one). ` +
        "Renames are a skip unit: " +
        (others.length > 0
          ? `move ${others.join(", ")} to the unit they belong to or a skim unit of their own, then make ${u.id} skip.`
          : `make ${u.id} skip.`),
    );
  }
  return out;
}
