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
