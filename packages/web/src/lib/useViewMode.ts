import { useCallback, useEffect, useState } from "react";

export type DiffViewMode = "unified" | "split";

const KEY = "reviewer.diffViewMode";

function read(): DiffViewMode {
  try {
    return localStorage.getItem(KEY) === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
}

/** Diff view mode, persisted across sessions. Defaults to unified. */
export function useDiffViewMode(): [DiffViewMode, (mode: DiffViewMode) => void, () => void] {
  const [mode, setModeState] = useState<DiffViewMode>(read);

  const setMode = useCallback((next: DiffViewMode) => {
    setModeState(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* private mode / storage disabled — keep the in-memory preference */
    }
  }, []);

  const toggle = useCallback(() => {
    setModeState((cur) => {
      const next = cur === "unified" ? "split" : "unified";
      try {
        localStorage.setItem(KEY, next);
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  // Keep other tabs in sync (cheap, and avoids a stale preference on reload).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setModeState(read());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return [mode, setMode, toggle];
}
