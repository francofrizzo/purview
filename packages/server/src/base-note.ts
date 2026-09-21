import {
  cachedDefaultBranch,
  readMeta,
  repoKeyOf,
  type Meta,
  type PrKey,
} from "@reviewer/core";
import type { CheckoutResolution } from "./worktree.js";

/** Purview's own exact checkout, i.e. the one `base-file` is wired to. */
export function isManagedCheckout(resolution?: CheckoutResolution): boolean {
  return !!(resolution?.managed && resolution.path && !resolution.error);
}

/**
 * The one line telling a run what the PR targets. Pure: the default branch is
 * passed in (see `baseNote` for where it comes from). Empty when either side
 * is unknown — old meta before its first backfill, or a repo whose default
 * branch was never read — since a guess here would mislead more than silence.
 */
export function formatBaseNote(
  meta: Pick<Meta, "baseRef" | "basePr">,
  defaultBranch: string | null,
  opts: { managed: boolean },
): string {
  const base = meta.baseRef;
  if (!base || !defaultBranch) return "";
  if (base === defaultBranch) return `Base: this PR targets ${base} (the default branch).`;
  const pr = meta.basePr;
  const ref = pr ? `#${pr.number}` : base;
  return [
    `Base: this PR is STACKED. It targets ${base}, ${
      pr ? `which is the head of #${pr.number} "${pr.title}" (${pr.url}), ` : ""
    }not ${defaultBranch}.`,
    `The diff shows only this PR's own changes on top of ${ref}.`,
    `Code that looks new but isn't in the diff came from ${ref}, so review it there, not here.`,
    opts.managed
      ? `\`base-file\` shows files ${pr ? `as ${ref} leaves them` : `as they are on ${base}`}.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * `formatBaseNote` for a PR on disk, shared by the analysis prompt and the chat
 * prompts. Never calls `gh`: the default branch comes from the per-repo cache
 * that init/refresh/staleness keep warm, and missing data prints nothing.
 */
export function baseNote(key: PrKey, root: string, checkout?: CheckoutResolution): string {
  try {
    const meta = readMeta(key, root);
    return formatBaseNote(meta, cachedDefaultBranch(repoKeyOf(key), root), {
      managed: isManagedCheckout(checkout),
    });
  } catch {
    return "";
  }
}
