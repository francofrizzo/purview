import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/**
 * A popover drawn at the document root and pinned under its anchor with
 * fixed positioning, so no ancestor's overflow can hide it — the top bar's
 * facts line clips (and fades) whatever does not fit, popovers included.
 * Closes on a press outside it and its anchor, on Escape, and on scroll or
 * resize (a fixed panel would otherwise drift away from its anchor).
 */
export function FloatingPanel({
  anchorRef,
  onClose,
  label,
  className = "",
  children,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Measured before paint: under the anchor, kept 8px inside the window.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const width = panelRef.current?.offsetWidth ?? 0;
    setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) });
  }, [anchorRef]);

  useEffect(() => {
    const inside = (t: EventTarget | null) =>
      t instanceof Node && (anchorRef.current?.contains(t) || panelRef.current?.contains(t));
    const onDown = (e: MouseEvent) => {
      if (!inside(e.target)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    const onScroll = (e: Event) => {
      if (!inside(e.target)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [anchorRef, onClose]);

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={label}
      className={`surface fixed z-50 rounded-md elev-2 ${className}`}
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? "visible" : "hidden" }}
    >
      {children}
    </div>,
    document.body,
  );
}
