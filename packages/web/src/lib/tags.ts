/** Reuse the eight theme-derived kind-chip pairs, including their contrast floors. */
export const TAG_COLORS = ["core", "glue", "refactor", "data", "wiring", "ripple", "tests", "docs"] as const;

export function tagSlot(name: string): number {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) hash = Math.imul(hash ^ name.charCodeAt(i), 16777619);
  return (hash >>> 0) % TAG_COLORS.length;
}

export const normalizeTag = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");
