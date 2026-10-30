/**
 * Which risk flags say something about one unit. A flag that runs through
 * the units to read closely (money, across a billing PR) is the PR's subject,
 * not a reason to look at one of them first: on every row it becomes
 * wallpaper. Only a flag that sets a unit apart earns a place on its row.
 */

import type { ReviewUnit } from "../api/types";

/**
 * Flags on at least two of the given units and at least a third of them:
 * the baseline. A flag on one unit always sets it apart.
 */
export function commonRiskFlags(units: readonly Pick<ReviewUnit, "riskFlags">[]): ReadonlySet<string> {
  const count = new Map<string, number>();
  for (const u of units) for (const f of new Set(u.riskFlags)) count.set(f, (count.get(f) ?? 0) + 1);
  return new Set([...count].filter(([, n]) => n >= 2 && n * 3 >= units.length).map(([f]) => f));
}
