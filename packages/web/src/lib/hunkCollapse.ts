/**
 * Which hunks are folded shut, and why.
 *
 * Collapse is ephemeral (a property of this sitting, not a preference), keyed
 * by hunk id, and driven from two places that must not fight each other:
 * the reader folding a hunk by hand, and the viewed checkbox folding it for
 * them. The rule is "the last thing that happened wins" — a manual fold sticks
 * until the viewed state next *changes*, at which point auto-collapse takes
 * over again. Modelled as a plain map plus pure transitions so it is testable
 * without a DOM.
 */

export type CollapsedMap = Readonly<Record<string, boolean>>;

export const EMPTY_COLLAPSED: CollapsedMap = {};

export function isCollapsed(state: CollapsedMap, hunkId: string): boolean {
  return state[hunkId] === true;
}

/** Manual fold/unfold. Always available, and it overrides whatever auto did. */
export function toggleCollapsed(state: CollapsedMap, hunkId: string): CollapsedMap {
  return { ...state, [hunkId]: !state[hunkId] };
}

export function setCollapsed(
  state: CollapsedMap,
  hunkId: string,
  collapsed: boolean,
): CollapsedMap {
  if (isCollapsed(state, hunkId) === collapsed) return state;
  return { ...state, [hunkId]: collapsed };
}

/** Viewed flags, as the PR detail carries them. */
export type ViewedMap = Readonly<Record<string, boolean>>;

/**
 * Fold every hunk whose viewed flag just flipped on, unfold every one that
 * just flipped off. Only *changes* are acted on: a hunk that was already
 * viewed when the reader unfolded it by hand stays unfolded, because nothing
 * about its viewed state moved.
 *
 * Returns the same object when there is nothing to do, so a caller can drop it
 * straight into `setState` without re-rendering.
 */
export function reconcileViewed(
  state: CollapsedMap,
  previous: ViewedMap,
  next: ViewedMap,
  autoCollapse: boolean,
): CollapsedMap {
  if (!autoCollapse) return state;
  let out: Record<string, boolean> | null = null;
  for (const id of Object.keys(next)) {
    const was = previous[id] === true;
    const now = next[id] === true;
    if (was === now) continue;
    if (isCollapsed(state, id) === now) continue;
    if (!out) out = { ...state };
    out[id] = now;
  }
  return out ?? state;
}

/** Snapshot of the viewed flags, reduced to the booleans this module compares. */
export function viewedSnapshot(
  hunks: Record<string, { viewed?: boolean } | undefined>,
): ViewedMap {
  const out: Record<string, boolean> = {};
  for (const [id, st] of Object.entries(hunks)) out[id] = st?.viewed === true;
  return out;
}

/** Hunks the reader can no longer see have no business holding state. */
export function pruneCollapsed(state: CollapsedMap, liveIds: Iterable<string>): CollapsedMap {
  const live = new Set(liveIds);
  const keys = Object.keys(state);
  if (keys.every((k) => live.has(k))) return state;
  const out: Record<string, boolean> = {};
  for (const k of keys) if (live.has(k)) out[k] = state[k];
  return out;
}
