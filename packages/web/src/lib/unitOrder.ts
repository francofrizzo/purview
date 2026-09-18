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

import { ATTENTIONS, type Attention, type ReviewUnit } from "../api/types";

function attentionRank(attention: Attention): number {
  const idx = ATTENTIONS.indexOf(attention);
  return idx === -1 ? ATTENTIONS.length : idx;
}

export function unitDisplayOrder(units: ReviewUnit[]): ReviewUnit[] {
  return [...units].sort((a, b) => {
    const ra = attentionRank(a.attention);
    const rb = attentionRank(b.attention);
    return ra !== rb ? ra - rb : a.order - b.order;
  });
}

/** unit id -> 1-based display number, in `unitDisplayOrder`'s order. */
export function unitDisplayNumbers(units: ReviewUnit[]): Map<string, number> {
  const out = new Map<string, number>();
  unitDisplayOrder(units).forEach((u, i) => out.set(u.id, i + 1));
  return out;
}
