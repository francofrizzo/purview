/**
 * The shared modal shell.
 *
 * Settings live at real URLs (`/settings`, `/repo/.../settings`) but render as
 * an overlay on top of whatever the user was already looking at — see the
 * background-location routing in `App.tsx`. This file owns the chrome for that:
 * a dimmed backdrop, an elevated card that scrolls internally, Escape/backdrop
 * dismissal, a focus trap and a body scroll lock.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate, type Location } from "react-router-dom";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The location the modal is floating over. On a normal page that is the page
 * itself; on a modal route it is whatever was underneath, so a modal that links
 * to another modal keeps the same backdrop.
 */
export function useModalBackground(): Location {
  const location = useLocation();
  const state = location.state as { background?: Location } | null;
  return state?.background ?? location;
}

/**
 * Closing is history-aware: if the modal was opened from inside the app we step
 * back to where we came from, and if the URL was pasted straight into the
 * address bar we replace it with the home route so there is no dead entry.
 */
export function useCloseModal(): () => void {
  const navigate = useNavigate();
  const location = useLocation();
  const hasBackground = Boolean((location.state as { background?: Location } | null)?.background);

  return useCallback(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (hasBackground && idx > 0) navigate(-1);
    else navigate("/", { replace: true });
  }, [hasBackground, navigate]);
}

export function Modal({
  title,
  subtitle,
  icon,
  actions,
  onClose,
  children,
  maxWidth = 880,
  testId,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  /** Buttons rendered next to the close ✕. */
  actions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  maxWidth?: number;
  testId?: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [entered, setEntered] = useState(false);

  // Fade/scale in on the frame after mount so the transition actually runs.
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Lock the page behind the modal; restore whatever inline value was there.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Move focus inside on open and hand it back to the opener on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = dialogRef.current;
    const first = node?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? node)?.focus({ preventScroll: true });
    return () => {
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, []);

  /**
   * One native listener on the card does three jobs: Escape closes, Tab cycles
   * inside, and everything else stops here. The routes underneath (diff pane,
   * top bar, PR view) listen for bare letter keys on window/document, so
   * without the stopPropagation typing in a settings field would drive the page
   * behind the dim.
   */
  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Tab") {
        const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
          (el) => el.offsetParent !== null || el === document.activeElement,
        );
        if (!items.length) {
          e.preventDefault();
        } else {
          const current = document.activeElement as HTMLElement | null;
          const i = current ? items.indexOf(current) : -1;
          const next = e.shiftKey
            ? items[i <= 0 ? items.length - 1 : i - 1]
            : items[i === -1 || i === items.length - 1 ? 0 : i + 1];
          e.preventDefault();
          next.focus();
        }
      }
      e.stopPropagation();
    };

    node.addEventListener("keydown", onKeyDown);
    return () => node.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Track where the press started so a text selection that ends on the
  // backdrop does not count as a backdrop click.
  const pressOnBackdrop = useRef(false);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-hidden p-4 sm:p-8"
      data-testid={testId}
      style={{
        background: "rgba(0,0,0,0.55)",
        opacity: entered ? 1 : 0,
        transition: "opacity 120ms ease-out",
      }}
      onMouseDown={(e) => {
        pressOnBackdrop.current = e.target === e.currentTarget;
      }}
      onMouseUp={(e) => {
        if (pressOnBackdrop.current && e.target === e.currentTarget) onClose();
        pressOnBackdrop.current = false;
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        tabIndex={-1}
        className="flex w-full flex-col overflow-hidden rounded-lg outline-none"
        style={{
          maxWidth,
          maxHeight: "85vh",
          marginTop: "clamp(0px, 6vh, 4rem)",
          background: "var(--bg-raised)",
          border: "1px solid var(--border-strong)",
          boxShadow: "0 24px 60px -12px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.25)",
          opacity: entered ? 1 : 0,
          transform: entered ? "scale(1)" : "scale(0.985)",
          transition: "opacity 120ms ease-out, transform 120ms ease-out",
        }}
      >
        <header
          className="flex flex-none items-baseline gap-3 border-b px-4 py-3"
          style={{ borderColor: "var(--border)", background: "var(--bg-raised)" }}
        >
          <h1 className="flex flex-none items-center gap-2 whitespace-nowrap text-sm font-semibold tracking-tight">
            {icon}
            {title}
          </h1>
          {subtitle ? (
            <p className="min-w-0 flex-1 truncate text-2xs" style={{ color: "var(--fg-muted)" }}>
              {subtitle}
            </p>
          ) : (
            <span className="flex-1" />
          )}
          <div className="ml-auto flex flex-none items-center gap-2">
            {actions}
            <button
              type="button"
              className="btn"
              data-testid="modal-close"
              title="Close"
              aria-label="Close"
              onClick={onClose}
            >
              ✕
            </button>
          </div>
        </header>

        {/* The vertical padding lives on the inner wrapper, not the scrollport:
            a `sticky bottom-0` child (the theme preview) pins to the padding
            box, so padding here would leave a strip of content showing under
            it. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4" data-testid="modal-scroll">
          <div className="py-4">{children}</div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
