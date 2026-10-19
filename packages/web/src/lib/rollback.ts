/**
 * The one line an optimistic action leaves behind when the server refuses
 * it: the screen already moved, then moved back, and nothing else says why.
 * Each entry is a mutation's `error` under the name of what it was doing;
 * the first one set wins, since a new attempt on any of them clears its own.
 */
import { errorText } from "../api/errors";

export interface RollbackSource {
  /** what was being done, as a noun phrase: "marking the hunk viewed" */
  label: string;
  error: unknown;
}

export function rollbackMessage(sources: RollbackSource[]): string | null {
  const failed = sources.find((s) => s.error);
  if (!failed) return null;
  return `${capitalize(failed.label)} failed: ${errorText(failed.error)}. The change was put back.`;
}

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
