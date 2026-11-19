import { experimentOn } from "./config.js";

/**
 * The run prompt's line for the `findingKinds` experiment: what `kind` each
 * warning takes. Empty while the experiment is off, or without a checkout
 * (no checkout, no findings), so the prompt is the one it was before.
 */
export function findingKindsPrompt(root: string, opts: { hasCheckout: boolean }): string {
  if (!experimentOn("findingKinds", root) || !opts.hasCheckout) return "";
  return [
    "FINDING KINDS: give every warning a `kind`.",
    "`bug`: the code does the wrong thing (a path mishandled, a site missed, a value wrong).",
    "`contract`: it may work here and still break what relies on it (callers of a changed signature, a stored, published or migrated shape, a config other code reads).",
    "`untested`: a behavior it changes that no test covers; grep the tests before saying so.",
    "A break with the documented architecture is not a finding: it belongs in `architecture` when that is asked for, and is left out otherwise.",
  ].join(" ");
}
