/**
 * The sidebar has two layout modes, decided purely from viewport width:
 * a permanent column (desktop, iPad landscape) or a floating drawer (iPad
 * portrait, narrow windows). `useSidebarMode` tracks the breakpoint with a
 * `matchMedia` listener rather than a resize loop.
 */

import { useEffect, useState } from "react";

export type SidebarMode = "column" | "drawer";

/** Below this width the sidebar can never be a column — see PrView.tsx. */
export const SIDEBAR_DRAWER_BREAKPOINT = 900;

const SIDEBAR_MODE_QUERY = `(min-width: ${SIDEBAR_DRAWER_BREAKPOINT}px)`;

export function sidebarModeFor(width: number): SidebarMode {
  return width >= SIDEBAR_DRAWER_BREAKPOINT ? "column" : "drawer";
}

function readSidebarMode(): SidebarMode {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "column";
  return window.matchMedia(SIDEBAR_MODE_QUERY).matches ? "column" : "drawer";
}

export function useSidebarMode(): SidebarMode {
  const [mode, setMode] = useState<SidebarMode>(readSidebarMode);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(SIDEBAR_MODE_QUERY);
    const onChange = () => setMode(mql.matches ? "column" : "drawer");
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return mode;
}
