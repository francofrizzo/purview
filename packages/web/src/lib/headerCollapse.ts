/**
 * When the diff pane's host header (the unit summary above the diff) should
 * be collapsed, given where the pane's scroller is.
 *
 * The trap this guards against: collapsing the header hands its height back
 * to the scroller, so the scroller's scrollable range shrinks by the same
 * amount and the browser clamps scrollTop down to fit. On a diff only a
 * little taller than the viewport that clamp lands back at the top, the
 * header expands, the range grows back, the next scroll collapses it again —
 * a flicker for as long as the reader keeps scrolling. So a collapse only
 * happens when the range left *after* it still keeps the reader past the
 * collapse point; a diff too short for that keeps its header whole.
 */

/** Past this many px from the top, the header may collapse. */
export const COLLAPSE_PAST = 40;
/** At or under this many px it expands again. The gap between the two is the
 *  hysteresis that keeps a header parked on the boundary from flickering. */
export const EXPAND_UNDER = 10;

export interface HeaderScrollState {
  /** The scroller's current geometry, as measured with the header as it is now. */
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** Px the scroller grows by when the header collapses. Overestimating it
   *  is safe (a borderline diff just keeps its header); underestimating is not. */
  collapsedDelta: number;
  /** Whether the header is collapsed right now. */
  collapsed: boolean;
}

export function nextHeaderCollapsed({
  scrollTop,
  scrollHeight,
  clientHeight,
  collapsedDelta,
  collapsed,
}: HeaderScrollState): boolean {
  if (collapsed) return scrollTop > EXPAND_UNDER;
  if (scrollTop <= COLLAPSE_PAST) return false;
  // The range once collapsed, i.e. where scrollTop can at most sit afterwards.
  const rangeAfter = scrollHeight - clientHeight - Math.max(0, collapsedDelta);
  return rangeAfter > COLLAPSE_PAST;
}
