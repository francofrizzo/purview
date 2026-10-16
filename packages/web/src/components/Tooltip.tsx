import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * The app's tooltips, one layer for all of them. Any element with `data-tip`
 * gets one: the text, plus the keys in `data-tip-key` (space-separated, each
 * drawn as a <kbd>). Native `title` tooltips are slow to appear, unstyled,
 * invisible on touch and cannot show a key the way the rest of the app does,
 * so nothing in the app uses them.
 *
 * Delegated from the document, so there is nothing to wrap: a short wait on
 * the first hover, none when moving straight to the next tipped element,
 * shown on focus too, and on a long press where there is no pointer. Hidden
 * by a press, a scroll, Escape or leaving the element.
 */
const OPEN_MS = 280;
/** moving between tipped elements within this window skips the wait */
const WARM_MS = 400;
const LONG_PRESS_MS = 450;
const GAP = 6;

interface Tip {
  text: string;
  keys: string[];
  /** the element's box, for placement */
  rect: DOMRect;
}

function tipOf(target: EventTarget | null): { el: HTMLElement; tip: Omit<Tip, "rect"> } | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest<HTMLElement>("[data-tip]");
  if (!el) return null;
  const text = el.dataset.tip ?? "";
  if (!text) return null;
  const keys = (el.dataset.tipKey ?? "").split(" ").filter(Boolean);
  return { el, tip: { text, keys } };
}

export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    let timer: number | null = null;
    let current: HTMLElement | null = null;
    let hiddenAt = 0;
    let pressTimer: number | null = null;

    const clear = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const hide = () => {
      clear();
      if (current) hiddenAt = Date.now();
      current = null;
      setTip(null);
    };
    const show = (el: HTMLElement, t: Omit<Tip, "rect">) => {
      current = el;
      setTip({ ...t, rect: el.getBoundingClientRect() });
    };
    const arm = (el: HTMLElement, t: Omit<Tip, "rect">) => {
      if (current === el) return;
      clear();
      const warm = Date.now() - hiddenAt < WARM_MS || current !== null;
      if (current) hiddenAt = Date.now();
      current = null;
      setTip(null);
      if (warm) show(el, t);
      else timer = window.setTimeout(() => show(el, t), OPEN_MS);
    };

    const onOver = (e: MouseEvent) => {
      const found = tipOf(e.target);
      if (!found) return;
      arm(found.el, found.tip);
    };
    const onOut = (e: MouseEvent) => {
      const found = tipOf(e.target);
      if (!found) return;
      // Leaving for somewhere inside the same element is not leaving.
      if (e.relatedTarget instanceof Node && found.el.contains(e.relatedTarget)) return;
      if (current === found.el || timer !== null) hide();
    };
    const onFocusIn = (e: FocusEvent) => {
      const found = tipOf(e.target);
      // Keyboard focus only: a click focuses too, and that one just hid it.
      if (found && found.el.matches(":focus-visible")) show(found.el, found.tip);
    };
    const onFocusOut = () => hide();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    const onTouchStart = (e: TouchEvent) => {
      const found = tipOf(e.target);
      if (!found) return;
      pressTimer = window.setTimeout(() => show(found.el, found.tip), LONG_PRESS_MS);
    };
    const onTouchEnd = () => {
      if (pressTimer !== null) window.clearTimeout(pressTimer);
      pressTimer = null;
      window.setTimeout(hide, 1200);
    };

    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    document.addEventListener("mousedown", hide, true);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchend", onTouchEnd);
    document.addEventListener("touchcancel", onTouchEnd);
    return () => {
      clear();
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
      document.removeEventListener("mousedown", hide, true);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("touchcancel", onTouchEnd);
    };
  }, []);

  if (!tip) return null;
  return createPortal(<TipCard tip={tip} />, document.body);
}

function TipCard({ tip }: { tip: Tip }) {
  // Under the element, centred; above it when there is no room below; never
  // past the window's edges.
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const ref = (el: HTMLDivElement | null) => {
    if (el && !box) setBox({ w: el.offsetWidth, h: el.offsetHeight });
  };
  const w = box?.w ?? 0;
  const h = box?.h ?? 0;
  const below = tip.rect.bottom + GAP + h <= window.innerHeight - 8;
  const top = below ? tip.rect.bottom + GAP : tip.rect.top - GAP - h;
  const left = Math.max(8, Math.min(tip.rect.left + tip.rect.width / 2 - w / 2, window.innerWidth - w - 8));
  return (
    <div
      ref={ref}
      role="tooltip"
      data-testid="tooltip"
      className="tip surface elev-2 pointer-events-none fixed z-[70] flex max-w-[20rem] items-center gap-1.5 rounded px-2 py-1 text-2xs leading-4"
      style={{ top, left, visibility: box ? "visible" : "hidden" }}
    >
      <span>{tip.text}</span>
      {tip.keys.length ? (
        <span className="flex flex-none items-center gap-0.5" aria-label={`shortcut ${tip.keys.join(" or ")}`}>
          {tip.keys.map((k, i) => (
            <kbd key={`${k}-${i}`}>{k}</kbd>
          ))}
        </span>
      ) : null}
    </div>
  );
}
