import { useCallback, useEffect, useMemo, useState } from "react";
import { targetKey, type CommentTarget } from "../components/Drafts";

/**
 * Text typed into a comment box and not saved yet, one per place it points
 * at. Opening another line puts the box away instead of throwing its text
 * out; opening that place again brings it back. Never a draft on the server:
 * a GitHub draft goes out with the review and a note goes to the agent on its
 * next pickup, and half a sentence should reach neither. Kept in this
 * browser per PR, so a reload keeps it too.
 */
export interface UnsavedDraft {
  target: CommentTarget;
  body: string;
  updatedAt: string;
}

const storageKey = (prKey: string) => `purview.unsaved:${prKey}`;

function read(prKey: string): Record<string, UnsavedDraft> {
  try {
    const raw = localStorage.getItem(storageKey(prKey));
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, UnsavedDraft>) : {};
  } catch {
    return {};
  }
}

function write(prKey: string, drafts: Record<string, UnsavedDraft>) {
  try {
    if (Object.keys(drafts).length) localStorage.setItem(storageKey(prKey), JSON.stringify(drafts));
    else localStorage.removeItem(storageKey(prKey));
  } catch {
    /* no storage: kept for this page only */
  }
}

export function useUnsavedDrafts(prKey: string) {
  const [drafts, setDrafts] = useState(() => read(prKey));
  useEffect(() => setDrafts(read(prKey)), [prKey]);

  const update = useCallback(
    (change: (cur: Record<string, UnsavedDraft>) => Record<string, UnsavedDraft>) =>
      setDrafts((cur) => {
        const next = change(cur);
        if (next !== cur) write(prKey, next);
        return next;
      }),
    [prKey],
  );

  /** Keep `body` for `target`; blank text keeps nothing. */
  const keep = useCallback(
    (target: CommentTarget, body: string) =>
      update((cur) => {
        const key = targetKey(target);
        if (!body.trim()) {
          if (!(key in cur)) return cur;
          const { [key]: _, ...rest } = cur;
          return rest;
        }
        return { ...cur, [key]: { target, body, updatedAt: new Date().toISOString() } };
      }),
    [update],
  );

  const drop = useCallback((target: CommentTarget) => keep(target, ""), [keep]);

  /** Newest first. */
  const list = useMemo(
    () => Object.values(drafts).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [drafts],
  );
  const bodyFor = useCallback((target: CommentTarget) => drafts[targetKey(target)]?.body ?? "", [drafts]);

  return { list, bodyFor, keep, drop };
}
