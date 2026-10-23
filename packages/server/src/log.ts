import type { PrKey } from "@reviewer/core";

type Fields = Record<string, unknown>;
type Level = "info" | "warn" | "error" | "debug";
interface Stream { isTTY?: boolean; write(text: string): unknown }
export function shortKey(key: PrKey): string {
  return `${key.owner}/${key.repo}#${key.number}`;
}
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

/** Injectable stream and clock keep formatting independent of the terminal. */
export function createLogger(stream: Stream = process.stderr, env: NodeJS.ProcessEnv = process.env, now = () => new Date()) {
  const debug = () => env.PURVIEW_DEBUG === "1" || (env.DEBUG ?? "").includes("purview");
  const write = (level: Level, scope: string, message: string, fields: Fields = {}) => {
    if (level === "debug" && !debug()) return;
    const date = now();
    const clean = (value: unknown): string => {
      const raw = value instanceof Error ? value.stack ?? value.message : typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
      return raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\r\x00-\x08\x0b-\x1f\x7f]/g, "");
    };
    const clip = (text: string) => !debug() && text.length > 120 ? text.slice(0, 119) + "…" : text;
    const values = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => [k, clean(v).split("\n").map(clip).join("\n")]));
    if (env.PURVIEW_LOG === "json") {
      stream.write(JSON.stringify({ time: date.toISOString(), level, scope, message: clip(clean(message)), fields: values }) + "\n");
      return;
    }
    // Pipes stay plain even when FORCE_COLOR is inherited from a parent process.
    const color = !!stream.isTTY && env.NO_COLOR === undefined && env.FORCE_COLOR !== "0";
    const ansi = (code: number, text: string) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
    const parts = clean(message).split("\n");
    const extra = parts.slice(1).map(clip);
    const fieldText = Object.entries(values).map(([k, v]) => {
      const [first, ...rest] = v.split("\n");
      extra.push(...rest);
      return `${k}=${first}`;
    }).join("  ");
    const time = stream.isTTY ? [date.getHours(), date.getMinutes(), date.getSeconds()].map(n => String(n).padStart(2, "0")).join(":") : date.toISOString();
    let hash = 0;
    for (const ch of scope) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const column = clean(scope).slice(0, 10).padEnd(10);
    const severity = level === "error" ? 31 : level === "warn" ? 33 : undefined;
    const line = severity
      ? ansi(severity, `${time}  ${column}  ${level === "error" ? "✗ " : ""}${clip(parts[0])}${fieldText ? "  " + fieldText : ""}`)
      : `${ansi(2, time)}  ${ansi([36, 35, 34, 32, 96][hash % 5], column)}  ${clip(parts[0])}${fieldText ? "  " + ansi(2, fieldText) : ""}`;
    stream.write(line + extra.map(part => "\n  " + ansi(2, part)).join("") + "\n");
  };
  const api = {
    info: (scope: string, message: string, fields?: Fields) => write("info", scope, message, fields),
    warn: (scope: string, message: string, fields?: Fields) => write("warn", scope, message, fields),
    error: (scope: string, message: string, fields?: Fields) => write("error", scope, message, fields),
    debug: (scope: string, message: string, fields?: Fields) => write("debug", scope, message, fields),
    child: (scope: string) => ({
      info: (message: string, fields?: Fields) => write("info", scope, message, fields),
      warn: (message: string, fields?: Fields) => write("warn", scope, message, fields),
      error: (message: string, fields?: Fields) => write("error", scope, message, fields),
      debug: (message: string, fields?: Fields) => write("debug", scope, message, fields),
    }),
  };
  return api;
}
export const log = createLogger();
