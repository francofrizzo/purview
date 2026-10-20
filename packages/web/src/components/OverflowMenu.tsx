import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconMore } from "./icons";

export interface MenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** the menu stays open after the click (the item opens something anchored to it) */
  keepOpen?: boolean;
  /** shown as the item's tooltip, not inline: the menu stays one line per action */
  hint?: string;
  icon?: React.ReactNode;
  /** a destructive action, drawn in the risk color */
  danger?: boolean;
  testId?: string;
  /** listed only at phone width, where its button leaves the row */
  narrowOnly?: boolean;
  /** starts a new group: a rule is drawn above it */
  dividerBefore?: boolean;
}

/**
 * The rarely-used actions, kept out of the button row. Also the repo group
 * header's ⋯ in the PR list, which passes its own test id, label and a
 * smaller trigger.
 */
export function OverflowMenu({
  items,
  testId = "topbar-overflow",
  label = "More actions",
  buttonClassName = "btn",
  buttonStyle,
  fixed = false,
}: {
  items: MenuItem[];
  testId?: string;
  label?: string;
  buttonClassName?: string;
  buttonStyle?: React.CSSProperties;
  /**
   * Render the menu in a portal, positioned against the viewport, so an
   * ancestor's `overflow: hidden` or opacity (a PR-list repo card, dimmed
   * when archived) cannot clip or fade it. It closes on scroll then, rather
   * than drifting away from its button.
   */
  fixed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Below the button, or above it when the button sits low on the screen
  // (the chat's, at the bottom of the panel) and the menu would fall off.
  const [anchor, setAnchor] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !fixed) return;
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open, fixed]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); // claimed: the page's own Escape leaves it alone
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const menu = (
    <div
      ref={menuRef}
      className={`surface z-40 w-52 rounded-md p-1 elev-2 ${fixed ? "fixed" : "absolute right-0 top-7"}`}
      style={fixed && anchor ? { top: anchor.top, bottom: anchor.bottom, right: anchor.right } : undefined}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          data-testid={item.testId}
          disabled={item.disabled}
          data-tip={item.hint}
          data-divider={item.dividerBefore ? "true" : undefined}
          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-50 ${
            item.narrowOnly ? "sm:hidden" : ""
          } ${item.dividerBefore ? "menu-divider" : ""}`}
          style={{ color: item.danger ? "var(--risk)" : "var(--fg)" }}
          onClick={() => {
            if (!item.keepOpen) setOpen(false);
            item.onClick();
          }}
        >
          <span className="flex w-3.5 flex-none items-center justify-center" style={{ color: item.danger ? "var(--risk)" : "var(--fg-muted)" }}>
            {item.icon}
          </span>
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
        </button>
      ))}
    </div>
  );

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className={buttonClassName}
        data-testid={testId}
        data-tip={label}
        aria-label={label}
        aria-expanded={open}
        style={buttonStyle}
        onClick={(e) => {
          if (fixed) {
            const r = e.currentTarget.getBoundingClientRect();
            const right = window.innerWidth - r.right;
            // Room for the menu below? Its height is about 34px a row.
            const below = window.innerHeight - r.bottom;
            setAnchor(
              below < items.length * 34 + 16
                ? { bottom: window.innerHeight - r.top + 4, right }
                : { top: r.bottom + 4, right },
            );
          }
          setOpen((v) => !v);
        }}
      >
        <IconMore width={12} height={12} />
      </button>
      {open ? (fixed ? createPortal(menu, document.body) : menu) : null}
    </div>
  );
}

