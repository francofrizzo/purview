/**
 * Write / Preview in the comment editors (the composer and a comment's inline
 * edit). Preview renders the body with Purview's own markdown renderer, which
 * is what the review page shows — not quite what GitHub will: no emoji
 * shortcodes, no `#123` / `@mention` autolinks.
 */

export type ComposerMode = "write" | "preview";

/** ⌘⇧P (Ctrl+Shift+P elsewhere) flips Write / Preview. Alt chords are left alone. */
export function isPreviewToggleKey(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  return (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "p";
}

export function toggledMode(mode: ComposerMode): ComposerMode {
  return mode === "write" ? "preview" : "write";
}

/** What the preview leaves out, worded for the control's tooltip. */
export const PREVIEW_LIMITS =
  "As Purview renders it. Emoji shortcodes (:tada:) and #123 / @mention links stay plain here; GitHub renders those.";

// The mode the reader last chose, for the next editor they open. Per tab
// session only: it is not a setting, so it is not persisted anywhere.
let lastMode: ComposerMode = "write";

export function rememberedMode(): ComposerMode {
  return lastMode;
}

export function rememberMode(mode: ComposerMode): void {
  lastMode = mode;
}
