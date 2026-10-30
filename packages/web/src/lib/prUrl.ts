import type { PrMeta } from "../api/types";
import { UNPLACED_ID } from "./unplaced";

/** The pseudo-unit's reserved id reads better in a URL as plain "unplaced". */
const UNPLACED_PARAM = "unplaced";

/** "core#8505 · Process successive batch snapshots · Purview" */
export function prPageTitle(meta: Pick<PrMeta, "repo" | "number" | "title">): string {
  const head = `${meta.repo}#${meta.number}`;
  return meta.title ? `${head} · ${meta.title} · Purview` : `${head} · Purview`;
}

/** The unit id a `?unit=` link asks for, or null. */
export function unitFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search).get("unit");
  if (!raw) return null;
  return raw === UNPLACED_PARAM ? UNPLACED_ID : raw;
}

/** `search` with `unit` set to `unitId` (or removed when null); other params kept. */
export function withUnitParam(search: string, unitId: string | null): string {
  const params = new URLSearchParams(search);
  if (unitId) params.set("unit", unitId === UNPLACED_ID ? UNPLACED_PARAM : unitId);
  else params.delete("unit");
  const s = params.toString();
  return s ? `?${s}` : "";
}

/** The three ways to read a PR, as the sidebar's tabs name them (`units` is the Guide). */
export type PrViewMode = "overview" | "units" | "files";

/** The view a `?view=` link asks for, or null (the PR picks: see PrView's first visit). */
export function viewFromSearch(search: string): PrViewMode | null {
  const raw = new URLSearchParams(search).get("view");
  if (raw === "overview" || raw === "files") return raw;
  if (raw === "guide") return "units";
  return null;
}

/** The file a `?file=` link asks for, or null. */
export function fileFromSearch(search: string): string | null {
  return new URLSearchParams(search).get("file") || null;
}

/**
 * `search` for the view on screen, so a reload or a copied link opens on it:
 * `view=overview` or `view=guide`, and in the Files view `view=files` with
 * `file=` its file. The unit param is left as it is (see withUnitParam), so
 * coming back to the Guide lands on the same unit.
 */
export function withViewParams(search: string, view: PrViewMode, file: string | null): string {
  const params = new URLSearchParams(search);
  params.set("view", view === "units" ? "guide" : view);
  if (view === "files" && file) params.set("file", file);
  else params.delete("file");
  const s = params.toString();
  return s ? `?${s}` : "";
}
