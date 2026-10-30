/**
 * Which section the jump bar underlines: the last one whose top has scrolled
 * past the panel's top edge (plus a little slack), or the first one.
 */
export function sectionInView(tops: number[], scrollTop: number, slack = 24): number {
  let i = 0;
  for (let k = 0; k < tops.length; k++) if (tops[k] - slack <= scrollTop) i = k;
  return i;
}

/** Headings would read as section titles in a two-paragraph overlay. */
export function withoutHeadings(text: string): string {
  return text.replace(/^(\s{0,3})#{1,6}\s+/gm, "$1");
}

/**
 * The description as GitHub shows it: HTML comments (PR templates are full of
 * them) never reach the reader there, so they don't here either.
 */
export function visibleDescription(body: string | undefined): string {
  return (body ?? "").replace(/<!--[\s\S]*?(-->|$)/g, "").trim();
}
