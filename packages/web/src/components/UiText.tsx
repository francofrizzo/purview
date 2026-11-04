/**
 * One of the app's own words: a button's label, a tab, a heading. Drawn by
 * CSS (`[data-ui]::before`), so the browser's find skips it and matches only
 * what the PR and the review say. Screen readers read it once. The hidden copy
 * is never painted nor found; it keeps the word in the element's text for
 * whatever reads that (tests, text matchers). Not for anything the PR, the
 * analysis or a person wrote.
 */
export function UiText({ children, className }: { children: string; className?: string }) {
  return (
    <span data-ui={children} className={className}>
      <span hidden>{children}</span>
    </span>
  );
}
