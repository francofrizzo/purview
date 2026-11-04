import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Modal } from "./Modal";
import { IconZoomIn, IconZoomOut } from "./icons";
import { UiText } from "./UiText";

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
/** A fitted diagram grows no further than this: a small chart stays a chart instead of a poster. */
const FIT_MAX = 2;
/** Each button press or key: one notch. */
const STEP = 1.25;

type View = { k: number; x: number; y: number };

/** The SVG's own size, from its viewBox. */
function naturalSize(svg: string): { w: number; h: number } | null {
  const m = /viewBox="[\d.\-]+ [\d.\-]+ ([\d.]+) ([\d.]+)"/.exec(svg);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

/**
 * A diagram opened large: the drawing on a rounded canvas that fills the
 * dialog, fitted to start. Pinch or Cmd/Ctrl+wheel zooms around the pointer,
 * a plain wheel or a drag moves it, a double click zooms in there. The header
 * holds −, the zoom (click: 100%), + and fit; the keys are +, −, 0 (fit) and
 * 1 (100%). With no `svg` it shows `fallback` instead (still drawing, or
 * could not be drawn).
 */
export function DiagramViewer({
  svg,
  fallback,
  title,
  onClose,
}: {
  svg: string | null;
  fallback?: ReactNode;
  title: ReactNode;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const size = svg ? naturalSize(svg) : null;
  const [view, setView] = useState<View | null>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);

  const fitted = useCallback((): View | null => {
    const el = canvasRef.current;
    if (!el || !size) return null;
    const pad = 32;
    const k = Math.min((el.clientWidth - pad * 2) / size.w, (el.clientHeight - pad * 2) / size.h, FIT_MAX);
    return { k, x: (el.clientWidth - size.w * k) / 2, y: (el.clientHeight - size.h * k) / 2 };
  }, [size?.w, size?.h]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fitted once it can be measured; until then nothing is painted.
  useLayoutEffect(() => {
    if (!view) setView(fitted());
  }, [fitted, view]);

  /** Zoom by `factor`, keeping the point (px, py) of the canvas where it is; the canvas's center by default. */
  const zoomAt = useCallback((factor: number, px?: number, py?: number) => {
    setView((v) => {
      const el = canvasRef.current;
      if (!v || !el) return v;
      const cx = px ?? el.clientWidth / 2;
      const cy = py ?? el.clientHeight / 2;
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * factor));
      const f = k / v.k;
      return { k, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f };
    });
  }, []);
  const fit = useCallback(() => setView(fitted()), [fitted]);
  const actual = useCallback(() => zoomAt(1 / (view?.k ?? 1)), [zoomAt, view?.k]);

  // The wheel is the canvas's, not the page's: a listener React cannot make non-passive.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      // A trackpad pinch arrives as a wheel with ctrlKey set.
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
      else setView((v) => (v ? { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY } : v));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt, svg]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "+" || e.key === "=") zoomAt(STEP);
      else if (e.key === "-") zoomAt(1 / STEP);
      else if (e.key === "0") fit();
      else if (e.key === "1") actual();
      else return;
      e.preventDefault();
    };
    // Captured: the dialog keeps its keys from bubbling past it.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [zoomAt, fit, actual]);

  const button =
    "inline-flex h-6 min-w-6 items-center justify-center rounded-[5px] px-1 text-2xs tabular-nums text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)] disabled:opacity-40";
  const controls = svg ? (
    <div className="flex items-center gap-px" data-testid="diagram-zoom">
      <button type="button" className={button} onClick={() => zoomAt(1 / STEP)} aria-label="Zoom out" data-tip="Zoom out" data-tip-key="−">
        <IconZoomOut width={14} height={14} />
      </button>
      <button
        type="button"
        className={`${button} w-11`}
        onClick={actual}
        aria-label="Actual size"
        data-tip="Actual size"
        data-tip-key="1"
        data-testid="diagram-zoom-level"
      >
        <UiText>{`${Math.round((view?.k ?? 1) * 100)}%`}</UiText>
      </button>
      <button type="button" className={button} onClick={() => zoomAt(STEP)} aria-label="Zoom in" data-tip="Zoom in" data-tip-key="+">
        <IconZoomIn width={14} height={14} />
      </button>
      <button type="button" className={`${button} ml-1`} onClick={fit} aria-label="Fit" data-tip="Fit to the window" data-tip-key="0" data-testid="diagram-fit">
        <UiText>fit</UiText>
      </button>
    </div>
  ) : null;

  return (
    <Modal title={title} actions={controls} maxWidth={1400} onClose={onClose} testId="mermaid-modal">
      <div
        ref={canvasRef}
        className={`relative h-[calc(100vh-14rem)] max-h-[960px] min-h-[240px] touch-none select-none overflow-hidden rounded-lg ${
          svg ? "cursor-grab active:cursor-grabbing" : "flex items-center justify-center"
        }`}
        style={{ background: "var(--bg-inset)", border: "1px solid var(--border)" }}
        data-testid="diagram-canvas"
        onPointerDown={(e) => {
          if (!svg || e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || d.id !== e.pointerId) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          drag.current = { ...d, x: e.clientX, y: e.clientY };
          setView((v) => (v ? { ...v, x: v.x + dx, y: v.y + dy } : v));
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onDoubleClick={(e) => {
          if (!svg) return;
          const r = e.currentTarget.getBoundingClientRect();
          zoomAt(2, e.clientX - r.left, e.clientY - r.top);
        }}
      >
        {svg && size ? (
          <div
            // Sized to the zoom rather than scaled, so the drawing stays sharp at any zoom.
            className="absolute left-0 top-0 [&_svg]:!h-full [&_svg]:!w-full [&_svg]:!max-w-none"
            style={{
              width: size.w * (view?.k ?? 1),
              height: size.h * (view?.k ?? 1),
              transform: view ? `translate(${view.x}px, ${view.y}px)` : undefined,
              visibility: view ? "visible" : "hidden",
            }}
            // mermaid runs under securityLevel "strict": nothing executable survives into this markup.
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          fallback
        )}
      </div>
    </Modal>
  );
}
