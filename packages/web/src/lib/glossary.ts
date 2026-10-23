/**
 * The PR's concepts as a glossary over the guide's prose: where a unit
 * summary, a heart or a finding names one (its term, or a name the code uses
 * for it), the reader can hover it for its meaning. The text stays exact for
 * whoever knows the words; whoever does not gets them where they appear.
 */

import type { Concept } from "../api/types";

export interface GlossaryHit {
  start: number;
  end: number;
  concept: Concept;
}

export interface Glossary {
  /** the concept a whole code span names (`UNRECONCILED`), if any */
  forCode(text: string): Concept | null;
  /** where a run of prose names a concept, in order and without overlaps */
  find(text: string): GlossaryHit[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A name counts only as a whole word: `tpk` in "tpk_id" or "tpks" is not it.
const WORD = "[\\p{L}\\p{N}_]";
const wholeWords = (names: string[], flags: string) =>
  new RegExp(
    `(?<!${WORD})(?:${[...names].sort((a, b) => b.length - a.length).map(escape).join("|")})(?!${WORD})`,
    flags,
  );

/**
 * A code's own names (`aka`) match as written, so `ENGINE` is not every
 * "engine" in a sentence; a term matches in any case, being ordinary words.
 * Where two overlap, the earlier and then the longer wins ("Snapshot source"
 * over "SNAPSHOT" inside it).
 */
export function buildGlossary(concepts: Concept[] | undefined): Glossary | null {
  if (!concepts?.length) return null;
  const exact = new Map<string, Concept>();
  const loose = new Map<string, Concept>();
  for (const c of concepts) {
    for (const name of c.aka) if (!exact.has(name)) exact.set(name, c);
    const term = c.term.toLowerCase();
    if (!loose.has(term)) loose.set(term, c);
  }
  const exactRe = exact.size ? wholeWords([...exact.keys()], "gu") : null;
  const looseRe = wholeWords([...loose.keys()], "giu");
  return {
    forCode(text) {
      const t = text.trim();
      return exact.get(t) ?? loose.get(t.toLowerCase()) ?? null;
    },
    find(text) {
      const hits: GlossaryHit[] = [];
      const collect = (re: RegExp | null, lookup: (m: string) => Concept | undefined) => {
        if (!re) return;
        for (const m of text.matchAll(re)) {
          const concept = lookup(m[0]);
          if (concept && m.index !== undefined) hits.push({ start: m.index, end: m.index + m[0].length, concept });
        }
      };
      collect(exactRe, (m) => exact.get(m));
      collect(looseRe, (m) => loose.get(m.toLowerCase()));
      hits.sort((a, b) => a.start - b.start || b.end - a.end);
      const out: GlossaryHit[] = [];
      let at = 0;
      for (const h of hits) {
        if (h.start < at) continue;
        out.push(h);
        at = h.end;
      }
      return out;
    },
  };
}

/** What the hover says: the term in the reader's words, then what it means. */
export function conceptTip(c: Concept): string {
  return `${c.term}${c.isNew ? " (new in this PR)" : ""}: ${c.means}`;
}
