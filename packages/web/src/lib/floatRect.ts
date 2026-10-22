/**
 * Geometry of the floating chat window: where it opens, how a drag or a
 * resize moves it, and how it is kept on screen. Pure, so the component only
 * wires pointers to it.
 */

import type { ChatFloatRect } from "./settings";

export const MIN_FLOAT_W = 320;
export const MIN_FLOAT_H = 260;
/** The gap kept between the window and the edge of the browser window. */
export const FLOAT_MARGIN = 8;

/** The edges and corners a resize can start from, named by the sides they move. */
export const FLOAT_HANDLES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
export type FloatHandle = (typeof FLOAT_HANDLES)[number];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

/** Where it opens the first time: the bottom-right corner, out of the diff's way. */
export function defaultFloatRect(vw: number, vh: number): ChatFloatRect {
  const w = Math.min(480, vw - 2 * FLOAT_MARGIN);
  const h = Math.min(600, vh - 120);
  return fitFloatRect({ x: vw - w - 24, y: vh - h - 24, w, h }, vw, vh);
}

/**
 * On screen whatever happened since it was placed: shrunk to a browser window
 * now smaller than it, then slid inside. The minimum size gives way to the
 * window, never the other way round.
 */
export function fitFloatRect(r: ChatFloatRect, vw: number, vh: number): ChatFloatRect {
  const w = Math.round(Math.min(Math.max(r.w, MIN_FLOAT_W), vw - 2 * FLOAT_MARGIN));
  const h = Math.round(Math.min(Math.max(r.h, MIN_FLOAT_H), vh - 2 * FLOAT_MARGIN));
  return {
    x: Math.round(clamp(r.x, FLOAT_MARGIN, vw - w - FLOAT_MARGIN)),
    y: Math.round(clamp(r.y, FLOAT_MARGIN, vh - h - FLOAT_MARGIN)),
    w,
    h,
  };
}

/** A drag of the title bar: the whole window moves, and stops at the edges. */
export function moveFloatRect(start: ChatFloatRect, dx: number, dy: number, vw: number, vh: number): ChatFloatRect {
  return fitFloatRect({ ...start, x: start.x + dx, y: start.y + dy }, vw, vh);
}

/**
 * A drag of an edge or corner: only the sides it names move, the opposite
 * ones stay put, and a moving side stops at the minimum size and at the edge
 * of the browser window (rather than pushing the whole window along).
 */
export function resizeFloatRect(
  start: ChatFloatRect,
  handle: FloatHandle,
  dx: number,
  dy: number,
  vw: number,
  vh: number,
): ChatFloatRect {
  let { x, y, w, h } = start;
  if (handle.includes("e")) w = clamp(start.w + dx, MIN_FLOAT_W, vw - FLOAT_MARGIN - start.x);
  if (handle.includes("w")) {
    w = clamp(start.w - dx, MIN_FLOAT_W, start.x + start.w - FLOAT_MARGIN);
    x = start.x + start.w - w;
  }
  if (handle.includes("s")) h = clamp(start.h + dy, MIN_FLOAT_H, vh - FLOAT_MARGIN - start.y);
  if (handle.includes("n")) {
    h = clamp(start.h - dy, MIN_FLOAT_H, start.y + start.h - FLOAT_MARGIN);
    y = start.y + start.h - h;
  }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}
