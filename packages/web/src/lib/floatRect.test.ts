import { describe, expect, it } from "vitest";
import {
  FLOAT_MARGIN,
  MIN_FLOAT_H,
  MIN_FLOAT_W,
  defaultFloatRect,
  fitFloatRect,
  moveFloatRect,
  resizeFloatRect,
} from "./floatRect";

const VW = 1400;
const VH = 900;

describe("defaultFloatRect", () => {
  it("opens in the bottom-right corner", () => {
    expect(defaultFloatRect(VW, VH)).toEqual({ x: 1400 - 480 - 24, y: 900 - 600 - 24, w: 480, h: 600 });
  });

  it("fits a small browser window", () => {
    const r = defaultFloatRect(400, 500);
    expect(r.x).toBeGreaterThanOrEqual(FLOAT_MARGIN);
    expect(r.x + r.w).toBeLessThanOrEqual(400 - FLOAT_MARGIN);
    expect(r.y + r.h).toBeLessThanOrEqual(500 - FLOAT_MARGIN);
  });
});

describe("fitFloatRect", () => {
  it("slides a window placed off screen back inside", () => {
    expect(fitFloatRect({ x: 1300, y: -40, w: 480, h: 600 }, VW, VH)).toEqual({
      x: VW - 480 - FLOAT_MARGIN,
      y: FLOAT_MARGIN,
      w: 480,
      h: 600,
    });
  });

  it("shrinks one bigger than the browser window, below the minimum if it has to", () => {
    expect(fitFloatRect({ x: 0, y: 0, w: 2000, h: 1200 }, VW, VH)).toEqual({
      x: FLOAT_MARGIN,
      y: FLOAT_MARGIN,
      w: VW - 2 * FLOAT_MARGIN,
      h: VH - 2 * FLOAT_MARGIN,
    });
    expect(fitFloatRect({ x: 0, y: 0, w: 480, h: 600 }, 300, 200).w).toBe(300 - 2 * FLOAT_MARGIN);
  });

  it("brings a stored size under the minimum up to it", () => {
    const r = fitFloatRect({ x: 100, y: 100, w: 10, h: 10 }, VW, VH);
    expect([r.w, r.h]).toEqual([MIN_FLOAT_W, MIN_FLOAT_H]);
  });
});

describe("moveFloatRect", () => {
  const start = { x: 500, y: 200, w: 480, h: 500 };

  it("moves by the drag", () => {
    expect(moveFloatRect(start, -120, 40, VW, VH)).toEqual({ ...start, x: 380, y: 240 });
  });

  it("stops at the edges without changing size", () => {
    expect(moveFloatRect(start, 5000, 5000, VW, VH)).toEqual({
      ...start,
      x: VW - 480 - FLOAT_MARGIN,
      y: VH - 500 - FLOAT_MARGIN,
    });
  });
});

describe("resizeFloatRect", () => {
  const start = { x: 500, y: 200, w: 480, h: 500 };

  it("the right and bottom edges grow it in place", () => {
    expect(resizeFloatRect(start, "se", 100, 50, VW, VH)).toEqual({ ...start, w: 580, h: 550 });
  });

  it("the left and top edges move those sides and keep the opposite ones", () => {
    const r = resizeFloatRect(start, "nw", -100, -50, VW, VH);
    expect(r).toEqual({ x: 400, y: 150, w: 580, h: 550 });
    expect(r.x + r.w).toBe(start.x + start.w);
  });

  it("stops at the minimum size, the opposite side still put", () => {
    const r = resizeFloatRect(start, "w", 1000, 0, VW, VH);
    expect(r.w).toBe(MIN_FLOAT_W);
    expect(r.x + r.w).toBe(start.x + start.w);
  });

  it("stops at the edge of the browser window instead of pushing the window", () => {
    expect(resizeFloatRect(start, "e", 5000, 0, VW, VH)).toEqual({ ...start, w: VW - FLOAT_MARGIN - 500 });
    expect(resizeFloatRect(start, "n", 0, -5000, VW, VH)).toEqual({ ...start, y: FLOAT_MARGIN, h: 200 + 500 - FLOAT_MARGIN });
  });

  it("an edge moves only its own side", () => {
    expect(resizeFloatRect(start, "s", 300, 60, VW, VH)).toEqual({ ...start, h: 560 });
  });
});
