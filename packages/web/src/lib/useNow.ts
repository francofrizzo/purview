import { useSyncExternalStore } from "react";

/**
 * A shared "now" that ticks once a minute, for relative stamps that must not
 * go stale on a page left open. One interval serves every subscriber, and it
 * only runs while something is subscribed.
 */
const TICK_MS = 60_000;

let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const snapshot = () => now;

/** Milliseconds since epoch, re-rendering the caller at least every minute. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
