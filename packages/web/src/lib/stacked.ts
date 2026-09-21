import type { PrMeta } from "../api/types";

export interface StackedOnLink {
  label: string;
  /** An in-app route when `internal`, else the PR's GitHub URL. */
  href: string;
  internal: boolean;
  title: string;
}

/**
 * What the header's "stacked on #n" chip shows and where it goes: into
 * Purview when the base PR is tracked here, out to GitHub otherwise. `null`
 * when the PR is not known to sit on another PR.
 */
export function stackedOnLink(
  meta: Pick<PrMeta, "host" | "owner" | "repo" | "baseRef" | "basePr">,
  tracked: boolean,
): StackedOnLink | null {
  const pr = meta.basePr;
  if (!pr) return null;
  return {
    label: `stacked on #${pr.number}`,
    href: tracked ? `/pr/${meta.host}/${meta.owner}/${meta.repo}/${pr.number}` : pr.url,
    internal: tracked,
    title:
      (meta.baseRef
        ? `Targets ${meta.baseRef}, the head of #${pr.number} "${pr.title}"`
        : `Stacked on #${pr.number} "${pr.title}"`) + (tracked ? "" : " (opens on GitHub)"),
  };
}
