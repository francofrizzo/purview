import { useSyncExternalStore } from "react";

/**
 * Whether GitHub can be reached, for the offline notice. Two sources: the
 * server's `X-Purview-GitHub-Offline` header on every API answer (gh failed
 * to connect, see core's github.ts), and the browser's own `navigator.onLine`,
 * which knows first when the machine drops its network. Purview's server is
 * local, so being offline only stops what needs GitHub.
 */
export const GITHUB_OFFLINE_HEADER = "x-purview-github-offline";

let serverSince: string | null = null;
let browserSince: string | null =
  typeof navigator !== "undefined" && navigator.onLine === false ? new Date().toISOString() : null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** What the last API answer said: when GitHub stopped answering, or null. */
export function noteGithubOffline(since: string | null): void {
  if (since === serverSince) return;
  serverSince = since;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    }
  };
}

function onOnline() {
  browserSince = null;
  emit();
}

function onOffline() {
  browserSince = new Date().toISOString();
  emit();
}

const snapshot = () => browserSince ?? serverSince;

/** When GitHub became unreachable, or null while it answers. */
export function useOfflineSince(): string | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
