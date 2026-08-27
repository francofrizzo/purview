/**
 * The auto-attach state machine behind the composer's default unit ref.
 *
 * When nothing is explicitly staged, the composer quietly points at whatever
 * unit the reader has selected — "explain this" should just work without a
 * manual quote. This module is the pure derivation: given what unit is in
 * context (or none, e.g. the files tab) and whether the reader dismissed the
 * auto chip, what should the composer actually show and send.
 *
 * Kept separate from ChatProvider so the state machine — explicit-wins,
 * suppression, its two ways to lift — can be tested without React.
 */

import type { ChatRef } from "../api/types";
import { refKey } from "./chatRefs";

export interface AutoRefState {
  /** The unit currently in context, or null (files tab, no PR loaded, etc). */
  selectedUnitId: string | null;
  /** Set when the reader dismissed the auto chip for the current selection. */
  suppressed: boolean;
}

export const initialAutoRefState: AutoRefState = { selectedUnitId: null, suppressed: false };

export type AutoRefAction =
  /** The unit-in-context changed (or the reader left the units tab: null). */
  | { type: "select-unit"; unitId: string | null }
  /** The panel just transitioned from closed to open. */
  | { type: "panel-opened" }
  /** The reader dismissed the auto chip via its own X. */
  | { type: "remove-auto" }
  /** A new PR/conversation: drop any unit context and dismissal. */
  | { type: "reset" };

/**
 * A unit switch always lifts suppression — it reads as "point at this one
 * instead", not "keep it dismissed for the new unit". Reopening the panel is
 * the other reset the feature promises; every other action leaves suppression
 * as it was.
 */
export function autoRefReducer(state: AutoRefState, action: AutoRefAction): AutoRefState {
  switch (action.type) {
    case "select-unit":
      if (action.unitId === state.selectedUnitId) return state;
      return { selectedUnitId: action.unitId, suppressed: false };
    case "panel-opened":
      return state.suppressed ? { ...state, suppressed: false } : state;
    case "remove-auto":
      return state.suppressed ? state : { ...state, suppressed: true };
    case "reset":
      return state === initialAutoRefState ||
        (state.selectedUnitId === null && !state.suppressed)
        ? state
        : initialAutoRefState;
    default:
      return state;
  }
}

/** The synthetic ref the auto chip points at, or null when there is none. */
export function autoRef(state: AutoRefState): ChatRef | null {
  return state.selectedUnitId ? { kind: "unit", id: state.selectedUnitId } : null;
}

/**
 * Explicit refs win outright: any staged ref replaces the auto chip. Absent
 * those, the auto ref shows unless the reader dismissed it or there is no
 * unit in context (e.g. the files tab).
 */
export function effectiveRefs(explicitRefs: ChatRef[], state: AutoRefState): ChatRef[] {
  if (explicitRefs.length > 0) return explicitRefs;
  if (state.suppressed) return [];
  const ref = autoRef(state);
  return ref ? [ref] : [];
}

/** Whether `ref` is the auto-attached chip rather than an explicit one. */
export function isAutoRef(ref: ChatRef, explicitRefs: ChatRef[], state: AutoRefState): boolean {
  if (explicitRefs.length > 0) return false;
  const auto = autoRef(state);
  return auto !== null && !state.suppressed && refKey(ref) === refKey(auto);
}
