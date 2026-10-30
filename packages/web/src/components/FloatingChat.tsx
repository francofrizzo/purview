import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  FLOAT_HANDLES,
  defaultFloatRect,
  fitFloatRect,
  moveFloatRect,
  resizeFloatRect,
  type FloatHandle,
} from "../lib/floatRect";
import type { ChatFloatRect } from "../lib/settings";
import { IconChat, IconClose, IconDock, IconMinimizeWindow, IconSpinner } from "./icons";

const CURSORS: Record<FloatHandle, string> = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
};

/**
 * Edges are thin strips straddling the border, mostly outside it so they never
 * cover the transcript's scrollbar; corners are squares over their ends.
 */
function handleStyle(h: FloatHandle): React.CSSProperties {
  const out = -5;
  const edge = 7;
  const corner = 14;
  const style: React.CSSProperties = {
    position: "absolute",
    cursor: CURSORS[h],
    touchAction: "none",
    zIndex: 1,
  };
  if (h.length === 2) {
    Object.assign(style, { width: corner, height: corner });
    style[h.includes("n") ? "top" : "bottom"] = out;
    style[h.includes("w") ? "left" : "right"] = out;
    style.zIndex = 2;
  } else if (h === "n" || h === "s") {
    Object.assign(style, {
      left: 0,
      right: 0,
      height: edge,
      [h === "n" ? "top" : "bottom"]: out,
    });
  } else {
    Object.assign(style, {
      top: 0,
      bottom: 0,
      width: edge,
      [h === "w" ? "left" : "right"]: out,
    });
  }
  return style;
}

function useViewport(): { w: number; h: number } {
  const [vp, setVp] = useState(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }));
  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return vp;
}

/**
 * The chat popped out of the dock: a window over the page, dragged by its
 * title bar and resized from any edge or corner, that stays where it was put
 * (`rect`, remembered in settings) and always on screen. Minimized, it
 * stays mounted but hidden behind a pill, so a half-typed message and the
 * scroll position survive; the conversation itself lives in the chat store
 * either way.
 *
 * Pointers are captured on the bar or handle that started the gesture, so a
 * drag carries on over iframes (a diagram) and outside the window.
 */
export function FloatingChat({
  rect,
  onRectChange,
  busy,
  minimized,
  onMinimize,
  onRestore,
  onDock,
  onClose,
  children,
}: {
  rect: ChatFloatRect | null;
  /** once, at the end of a drag or resize */
  onRectChange: (rect: ChatFloatRect) => void;
  busy: boolean;
  minimized: boolean;
  onMinimize: () => void;
  onRestore: () => void;
  onDock: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const vp = useViewport();
  const [live, setLive] = useState<ChatFloatRect | null>(null);
  const placed = live ?? fitFloatRect(rect ?? defaultFloatRect(vp.w, vp.h), vp.w, vp.h);
  const windowRef = useRef<HTMLDivElement>(null);

  // Back from the pill, the reader is about to type.
  const wasMinimized = useRef(minimized);
  useEffect(() => {
    if (wasMinimized.current && !minimized) {
      windowRef.current?.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')?.focus();
    }
    wasMinimized.current = minimized;
  }, [minimized]);

  const gesture = (e: ReactPointerEvent<HTMLElement>, apply: (dx: number, dy: number) => ChatFloatRect) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const sx = e.clientX;
    const sy = e.clientY;
    let last = placed;
    const prevSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    const move = (ev: PointerEvent) => {
      last = apply(ev.clientX - sx, ev.clientY - sy);
      setLive(last);
    };
    const end = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      document.body.style.userSelect = prevSelect;
      setLive(null);
      // Commit once, at the end: settings write to localStorage on every update.
      onRectChange(last);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  };

  const iconButton =
    "flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-[var(--bg-inset)] hover:text-[var(--fg)]";

  return createPortal(
    <>
      <div
        ref={windowRef}
        role="dialog"
        aria-label="Chat"
        data-testid="chat-float"
        // Over the diff and its floating bars (z-30), under menus (z-40), modals and tooltips.
        className="fixed z-[35]"
        style={{
          left: placed.x,
          top: placed.y,
          width: placed.w,
          height: placed.h,
          display: minimized ? "none" : undefined,
        }}
      >
        <div className="surface elev-3 absolute inset-0 flex flex-col overflow-hidden rounded-lg">
          <div
            data-testid="chat-float-bar"
            className="flex flex-none cursor-grab select-none items-center gap-1.5 border-b py-1 pl-3 pr-1.5 text-xs font-medium active:cursor-grabbing"
            style={{
              borderColor: "var(--border)",
              color: "var(--fg)",
              touchAction: "none",
            }}
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest("button")) return;
              const start = placed;
              gesture(e, (dx, dy) => moveFloatRect(start, dx, dy, vp.w, vp.h));
            }}
            onDoubleClick={(e) => {
              if (!(e.target as HTMLElement).closest("button")) onDock();
            }}
          >
            <IconChat width={12} height={12} style={{ color: "var(--fg-faint)" }} />
            <span>Chat</span>
            {busy ? <IconSpinner width={10} height={10} style={{ color: "var(--accent)" }} /> : null}
            <span className="ml-auto flex items-center" style={{ color: "var(--fg-faint)" }}>
              <button
                type="button"
                className={iconButton}
                onClick={onMinimize}
                aria-label="Minimize chat"
                data-tip="Minimize"
                data-testid="chat-float-minimize"
              >
                <IconMinimizeWindow width={12} height={12} />
              </button>
              <button
                type="button"
                className={iconButton}
                onClick={onDock}
                aria-label="Back to the side panel"
                data-tip="Back to the side panel"
                data-testid="chat-float-dock"
              >
                <IconDock width={12} height={12} />
              </button>
              <button
                type="button"
                className={iconButton}
                onClick={onClose}
                aria-label="Close chat"
                data-tip="Close"
                data-tip-key="c"
                data-testid="chat-float-close"
              >
                <IconClose width={11} height={11} />
              </button>
            </span>
          </div>
          {children}
        </div>
        {FLOAT_HANDLES.map((h) => (
          <div
            key={h}
            aria-hidden
            data-testid={`chat-float-resize-${h}`}
            style={handleStyle(h)}
            onPointerDown={(e) => {
              const start = placed;
              gesture(e, (dx, dy) => resizeFloatRect(start, h, dx, dy, vp.w, vp.h));
            }}
          />
        ))}
      </div>
      {minimized ? (
        <button
          type="button"
          data-testid="chat-pill"
          className="surface elev-2 fixed bottom-4 right-4 z-[35] flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors hover:text-[var(--fg)]"
          style={{ color: "var(--fg-muted)" }}
          onClick={onRestore}
          data-tip="Show the chat"
          data-tip-key="c"
        >
          <IconChat width={12} height={12} />
          Chat
          {busy ? <IconSpinner width={10} height={10} style={{ color: "var(--accent)" }} /> : null}
        </button>
      ) : null}
    </>,
    document.body,
  );
}
