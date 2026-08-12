/**
 * Tiny color helpers used to derive the app-chrome tokens from a theme palette.
 * Everything works on `#rgb` / `#rrggbb`; anything unparseable degrades to black
 * rather than throwing, so a malformed palette can never break rendering.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function parseHex(hex: string): Rgb {
  const s = hex.trim().replace(/^#/, "");
  if (s.length === 3 || s.length === 4) {
    const [r, g, b] = [s[0], s[1], s[2]].map((c) => parseInt(c + c, 16));
    return { r: r || 0, g: g || 0, b: b || 0 };
  }
  if (s.length === 6 || s.length === 8) {
    return {
      r: parseInt(s.slice(0, 2), 16) || 0,
      g: parseInt(s.slice(2, 4), 16) || 0,
      b: parseInt(s.slice(4, 6), 16) || 0,
    };
  }
  return { r: 0, g: 0, b: 0 };
}

const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

export function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((c) => clamp(c).toString(16).padStart(2, "0")).join("")}`;
}

/** `t = 0` keeps `a`, `t = 1` returns `b`. */
export function mix(a: string, b: string, t: number): string {
  const x = parseHex(a);
  const y = parseHex(b);
  return toHex({
    r: x.r + (y.r - x.r) * t,
    g: x.g + (y.g - x.g) * t,
    b: x.b + (y.b - x.b) * t,
  });
}

export function rgba(hex: string, alpha: number): string {
  const { r, g, b } = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function channelLum(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * channelLum(r) + 0.7152 * channelLum(g) + 0.0722 * channelLum(b);
}

/** WCAG contrast ratio, 1 (identical) … 21 (black on white). */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export function isLight(hex: string): boolean {
  return luminance(hex) > 0.45;
}

/**
 * Nudge `color` away from `bg` until it is readable on it. Dark backgrounds
 * push toward white, light backgrounds toward black. Gives every theme legible
 * accent text without hand-tuning each palette.
 */
export function readable(color: string, bg: string, min = 4.0): string {
  if (contrast(color, bg) >= min) return color;
  const target = isLight(bg) ? "#000000" : "#ffffff";
  let out = color;
  for (let t = 0.08; t <= 1.0001; t += 0.08) {
    out = mix(color, target, t);
    if (contrast(out, bg) >= min) return out;
  }
  return out;
}
