/**
 * Fullscreen + standalone (Home Screen app) detection. Safari on iPad only
 * exposes the webkit-prefixed fullscreen API, so every entry point here
 * checks both the standard and prefixed names.
 */

import { useCallback, useEffect, useState } from "react";

interface PrefixedDocument extends Document {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
}

interface PrefixedElement extends HTMLElement {
  webkitRequestFullscreen?: () => void;
}

interface PrefixedNavigator extends Navigator {
  standalone?: boolean;
}

function fullscreenSupported(): boolean {
  if (typeof document === "undefined") return false;
  const d = document as PrefixedDocument;
  return Boolean(d.fullscreenEnabled || d.webkitFullscreenEnabled);
}

function fullscreenElement(): Element | null {
  if (typeof document === "undefined") return null;
  const d = document as PrefixedDocument;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const mediaStandalone =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(display-mode: standalone)").matches;
  return Boolean(mediaStandalone || (navigator as PrefixedNavigator).standalone === true);
}

export function useFullscreen() {
  const supported = fullscreenSupported();
  const [active, setActive] = useState<boolean>(() => Boolean(fullscreenElement()));

  useEffect(() => {
    if (!supported) return;
    const onChange = () => setActive(Boolean(fullscreenElement()));
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, [supported]);

  const toggle = useCallback(() => {
    if (!supported) return;
    if (fullscreenElement()) {
      const d = document as PrefixedDocument;
      if (document.exitFullscreen) document.exitFullscreen();
      else d.webkitExitFullscreen?.();
    } else {
      const el = document.documentElement as PrefixedElement;
      if (el.requestFullscreen) el.requestFullscreen();
      else el.webkitRequestFullscreen?.();
    }
  }, [supported]);

  return { supported, active, toggle };
}
