/**
 * Hiding units the reader is done with.
 *
 * "Done" means every hunk in the unit is viewed. The one unit that is never
 * hidden is the selected one: the diff pane is showing it, and pulling it out
 * of the sidebar the instant its last hunk is ticked would yank the pane out
 * from under the reader. Pure — no PrDetail shape leaks in beyond the
 * predicate the caller supplies.
 */

export interface FilterableUnit {
  id: string;
}

export interface FilteredUnits<T extends FilterableUnit> {
  /** what the group renders */
  shown: T[];
  /** how many were dropped, for the "(n hidden)" hint */
  hidden: number;
}

export interface UnitFilterOptions<T extends FilterableUnit> {
  /** off → nothing is hidden and `hidden` is 0 */
  hide: boolean;
  /** true when every hunk of the unit has been viewed */
  isFullyViewed: (unit: T) => boolean;
  /** stays visible even when fully viewed */
  selectedId: string | null;
}

export function filterUnits<T extends FilterableUnit>(
  units: T[],
  { hide, isFullyViewed, selectedId }: UnitFilterOptions<T>,
): FilteredUnits<T> {
  if (!hide) return { shown: units, hidden: 0 };
  const shown = units.filter((u) => u.id === selectedId || !isFullyViewed(u));
  return { shown, hidden: units.length - shown.length };
}

/** "(2 hidden)" — or "" when there is nothing to say. */
export function hiddenHint(hidden: number): string {
  return hidden > 0 ? `(${hidden} hidden)` : "";
}
