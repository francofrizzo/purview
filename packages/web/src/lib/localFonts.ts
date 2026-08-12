/**
 * Local Font Access API wrapper (Chromium 103+, secure context only).
 *
 * `queryLocalFonts()` needs a user gesture and shows a permission prompt, so it
 * is only ever called from a click. Every failure mode — API missing, prompt
 * denied, empty result — resolves to a status the UI can explain, and the
 * curated list below plus the free-text family input keep the feature usable
 * without the API at all.
 */

export const CURATED_MONO_FONTS = [
  "SF Mono",
  "Menlo",
  "Monaco",
  "Consolas",
  "JetBrains Mono",
  "Fira Code",
  "Cascadia Code",
  "IBM Plex Mono",
  "Source Code Pro",
  "Roboto Mono",
  "Ubuntu Mono",
  "DejaVu Sans Mono",
  "monospace",
];

export type LocalFontStatus = "ok" | "unsupported" | "denied" | "empty" | "error";

export interface LocalFontResult {
  status: LocalFontStatus;
  families: string[];
  message?: string;
}

interface FontData {
  family: string;
  fullName?: string;
  postscriptName?: string;
  style?: string;
}

type WindowWithLocalFonts = Window & {
  queryLocalFonts?: () => Promise<FontData[]>;
};

export function localFontsSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as WindowWithLocalFonts).queryLocalFonts === "function"
  );
}

export const UNSUPPORTED_MESSAGE =
  "This browser doesn't expose the Local Font Access API (Chromium 103+ over localhost or HTTPS). " +
  "Pick from the common families below, or type any installed family by name.";

/** Must be called from a user gesture. Never rejects. */
export async function queryLocalFontFamilies(): Promise<LocalFontResult> {
  const q = (window as WindowWithLocalFonts).queryLocalFonts;
  if (typeof q !== "function") {
    return { status: "unsupported", families: [], message: UNSUPPORTED_MESSAGE };
  }
  try {
    const fonts = await q.call(window);
    const families = dedupeFamilies(fonts);
    if (!families.length) {
      return {
        status: "empty",
        families: [],
        message: "The browser returned no fonts. Type a family name instead.",
      };
    }
    return { status: "ok", families };
  } catch (err) {
    const name = (err as DOMException)?.name;
    if (name === "SecurityError" || name === "NotAllowedError") {
      return {
        status: "denied",
        families: [],
        message:
          "Permission to read local fonts was denied. Allow it in the browser's site settings, " +
          "or type a family name below.",
      };
    }
    return {
      status: "error",
      families: [],
      message: (err as Error)?.message ?? "Could not read local fonts.",
    };
  }
}

/** One entry per family, sorted case-insensitively. */
export function dedupeFamilies(fonts: { family?: string }[]): string[] {
  const seen = new Set<string>();
  for (const f of fonts) {
    const family = f?.family?.trim();
    if (family && !seen.has(family)) seen.add(family);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

export function filterFamilies(families: string[], query: string, limit = 400): string[] {
  const q = query.trim().toLowerCase();
  const matched = q ? families.filter((f) => f.toLowerCase().includes(q)) : families;
  return matched.slice(0, limit);
}
