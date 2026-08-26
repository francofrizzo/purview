import type { MiddlewareHandler } from "hono";
import { DEFAULT_DEV_ORIGINS } from "./config.js";

/**
 * CSRF / DNS-rebinding hardening for the local API.
 *
 * The threat this closes: a browser will happily send a cross-origin request to
 * http://127.0.0.1:4779 from any page on the internet. CORS only gates whether
 * the *response* can be read — the request still executes. Every side effect
 * this server has is therefore reachable from a random tab: spawning a Claude
 * analysis run (costs the user money), posting a comment, or submitting a
 * review. `confirm: true` guards nothing here, because the attacker writes the
 * body.
 *
 * Two checks, in order:
 *
 *  1. **Host** — must be loopback (`localhost`/`127.0.0.1`/`[::1]`) on our port.
 *     This is the DNS-rebinding defense: an attacker who repoints
 *     `evil.example` at 127.0.0.1 still sends `Host: evil.example`, and the
 *     browser will not let them forge it. Applied to *every* method, so cheap
 *     GET endpoints like the SSE `/events` stream are covered too.
 *
 *  2. **Origin** — only for state-changing methods (POST/PATCH/PUT/DELETE).
 *     GETs are deliberately left to the Host check alone: they do not mutate,
 *     and CORS already prevents a foreign page from reading what comes back, so
 *     blocking them would buy nothing while breaking plain browser navigation
 *     and the SSE stream in edge cases.
 */

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export interface GuardOptions {
  /** The port the server actually listens on. */
  port: number;
  /** Extra origins allowed to send state-changing requests (Vite dev proxy). */
  devOrigins?: string[];
}

export interface GuardVerdict {
  ok: boolean;
  status?: 403;
  code?: "forbidden_host" | "forbidden_origin";
  message?: string;
}

const OK: GuardVerdict = { ok: true };

/** The origins this server serves itself from. */
export function ownOrigins(port: number): string[] {
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
}

/**
 * `Host` must name a loopback interface. The port must be ours or absent —
 * absent means the caller is an in-process/unit-test client or a raw socket
 * client that never set one, and the port carries no security weight anyway
 * (rebinding is defeated by the hostname, and a browser reaching us at all
 * already used the right port).
 */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(host.trim());
  if (!m) return false;
  const hostname = m[1].toLowerCase();
  if (!LOOPBACK_HOSTNAMES.has(hostname)) return false;
  return m[2] === undefined || Number(m[2]) === port;
}

const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export interface RequestFacts {
  method: string;
  host: string | undefined;
  origin: string | undefined;
  secFetchSite: string | undefined;
}

/** Pure decision function — the middleware is a thin wrapper over this. */
export function checkRequest(facts: RequestFacts, opts: GuardOptions): GuardVerdict {
  const port = opts.port;
  if (!isAllowedHost(facts.host, port)) {
    return {
      ok: false,
      status: 403,
      code: "forbidden_host",
      message:
        `Refusing a request with Host "${facts.host ?? "(none)"}". ` +
        `This server only answers to localhost:${port}.`,
    };
  }

  if (!MUTATING.has(facts.method.toUpperCase())) return OK;

  const site = facts.secFetchSite?.toLowerCase();
  // A browser that labels the request cross-site is telling us outright that it
  // did not come from our own page — reject before even looking at Origin.
  if (site === "cross-site" || site === "same-site") {
    return {
      ok: false,
      status: 403,
      code: "forbidden_origin",
      message: `Refusing a ${site} ${facts.method} request to the local API.`,
    };
  }

  const origin = facts.origin;
  // No Origin at all: curl, the CLI, a same-origin form navigation. Browsers
  // always attach one to a cross-origin state-changing request, so "absent" is
  // not something an attacking page can arrange.
  if (origin === undefined || origin === "") {
    // `sec-fetch-site: same-origin|none` is the corroborating signal when
    // present; its absence (non-browser client) is fine.
    return OK;
  }

  const allowed = new Set([...ownOrigins(port), ...(opts.devOrigins ?? DEFAULT_DEV_ORIGINS)]);
  if (allowed.has(origin)) return OK;

  return {
    ok: false,
    status: 403,
    code: "forbidden_origin",
    message:
      `Refusing a ${facts.method} from origin "${origin}". ` +
      `Only the app's own origin may change state; add trusted dev origins to ` +
      `~/.reviewer/config.json under "devOrigins".`,
  };
}

/**
 * Hono middleware form. Replaces the previous permissive CORS middleware
 * outright: a same-origin app needs no CORS headers, and emitting none is what
 * keeps a foreign page from reading any response it manages to trigger.
 */
export function localOnlyGuard(opts: GuardOptions): MiddlewareHandler {
  return async (c, next) => {
    // @hono/node-server builds the request URL from the Host header, so the two
    // agree over a real socket; the URL fallback is for in-process clients
    // (tests, `app.request`) where fetch never materialises a Host header.
    let urlHost: string | undefined;
    try {
      urlHost = new URL(c.req.url).host;
    } catch {
      urlHost = undefined;
    }
    const verdict = checkRequest(
      {
        method: c.req.method,
        host: c.req.header("host") ?? urlHost,
        origin: c.req.header("origin"),
        secFetchSite: c.req.header("sec-fetch-site"),
      },
      opts,
    );
    if (!verdict.ok) {
      return c.json({ error: verdict.code, detail: verdict.message }, 403);
    }
    return next();
  };
}
