/**
 * The one true reading order for review units — must-read, then skim, then
 * skip, `order` ascending within each bucket — and the 1-based numbering the
 * sidebar and the collapsed rail both show. Shared so the two can never
 * disagree: previously the sidebar computed its own numbering inline.
 *
 * An attention outside the known set (should not happen, but state is
 * loaded from disk/network) sorts after every known bucket rather than
 * before it, so a bad value can't jump a unit to the front of the list.
 */

import { ATTENTIONS, isGeneratedUnit, isRemovedUnit, type Attention, type ReviewUnit } from "../api/types";

function attentionRank(attention: Attention): number {
  const idx = ATTENTIONS.indexOf(attention);
  return idx === -1 ? ATTENTIONS.length : idx;
}

/**
 * Husks (units whose hunks all left the PR) are never part of the reading
 * order. The client adapter already keeps them out of `state.units`; this is
 * the backstop so numbering can't gap if one ever slips through.
 *
 * The generated-files unit closes its bucket whatever its `order`: Purview
 * builds it outside the analysis, so its `order` means nothing next to the
 * analysis's, and machine output is the last thing anyone wants to read.
 */
export function unitDisplayOrder(units: ReviewUnit[]): ReviewUnit[] {
  return units.filter((u) => !isRemovedUnit(u)).sort((a, b) => {
    const ra = attentionRank(a.attention);
    const rb = attentionRank(b.attention);
    if (ra !== rb) return ra - rb;
    const ga = isGeneratedUnit(a) ? 1 : 0;
    const gb = isGeneratedUnit(b) ? 1 : 0;
    return ga !== gb ? ga - gb : a.order - b.order;
  });
}

/** unit id -> 1-based display number, in `unitDisplayOrder`'s order. */
export function unitDisplayNumbers(units: ReviewUnit[]): Map<string, number> {
  const out = new Map<string, number>();
  unitDisplayOrder(units).forEach((u, i) => out.set(u.id, i + 1));
  return out;
}
