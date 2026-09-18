import { timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
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
 *
 * **LAN mode** (opt-in, off by default — see config.ts) widens the Host check
 * to this machine's own names on the network, and only there. That trade has
 * to be paid for: the loopback restriction *was* the authentication, so a
 * request arriving under a LAN name must carry the shared token instead. A
 * loopback request stays exempt, which is what keeps the desktop browser, the
 * CLI, curl and the tests working exactly as before.
 *
 * The token rides a cookie rather than a header because the header cannot
 * cover the whole surface: `EventSource` (the SSE stream) sets no custom
 * headers, and neither do `<script>` / `<link>` asset loads. The header is
 * accepted as a second way in for non-browser clients.
 */

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Where a LAN device's token lives once it has been through the bootstrap. */
export const TOKEN_COOKIE = "purview_token";

/** Header form of the same secret, for clients that are not a browser. */
export const TOKEN_HEADER = "x-purview-token";

/** LAN access as the guard sees it; `null`/absent means loopback-only. */
export interface LanOptions {
  /** Hostnames (no port, lowercased) this machine answers to on the LAN. */
  hosts: string[];
  /** The shared secret a request under one of those hosts must present. */
  token: string;
}

export interface GuardOptions {
  /** The port the server actually listens on. */
  port: number;
  /** Extra origins allowed to send state-changing requests (Vite dev proxy). */
  devOrigins?: string[];
  /** Resolved LAN access; read per request, so a regenerated token takes effect at once. */
  lan?: LanOptions | null;
}

export interface GuardVerdict {
  ok: boolean;
  status?: 401 | 403;
  code?: "forbidden_host" | "forbidden_origin" | "unauthorized";
  message?: string;
  /**
   * A GET that arrived with a matching `?token=`. The middleware answers it
   * itself — cookie, then a redirect to `location` — so the secret does not
   * stay in history or a bookmark. Terminal: the request never reaches a route.
   */
  bootstrap?: { token: string; location: string };
}

const OK: GuardVerdict = { ok: true };

/** The origins this server serves itself from. */
export function ownOrigins(port: number): string[] {
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
}

/** `http://<name>:<port>` for every LAN name — the origins a LAN page sends from. */
export function lanOrigins(hosts: string[], port: number): string[] {
  return hosts.map((host) => `http://${host}:${port}`);
}

/**
 * The hostname out of a `Host` value, or `null` when the port is someone
 * else's. The port must be ours or absent — absent means the caller is an
 * in-process/unit-test client or a raw socket client that never set one, and
 * the port carries no security weight anyway (rebinding is defeated by the
 * hostname, and a browser reaching us at all already used the right port).
 */
function hostnameOf(host: string | undefined, port: number): string | null {
  if (!host) return null;
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(host.trim());
  if (!m) return null;
  if (m[2] !== undefined && Number(m[2]) !== port) return null;
  return m[1].toLowerCase();
}

/** `Host` must name a loopback interface. */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  const hostname = hostnameOf(host, port);
  return hostname !== null && LOOPBACK_HOSTNAMES.has(hostname);
}

/** `Host` names this machine on the LAN — only meaningful while LAN mode is on. */
export function isLanHost(host: string | undefined, port: number, hosts: string[]): boolean {
  const hostname = hostnameOf(host, port);
  return hostname !== null && hosts.includes(hostname);
}

const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export interface RequestFacts {
  method: string;
  host: string | undefined;
  origin: string | undefined;
  secFetchSite: string | undefined;
  /** Pathname, for the bootstrap redirect. Defaults to "/". */
  path?: string;
  /** Raw query string; `token` is read out of it and stripped from the redirect. */
  search?: string;
  /** Raw `Cookie` header — the primary way a LAN device carries the token. */
  cookie?: string;
  /** `x-purview-token`, for clients that cannot hold a cookie. */
  tokenHeader?: string;
}

/**
 * Constant-time compare that also survives a length mismatch — `timingSafeEqual`
 * throws on one, and the length of a presented token is not a secret.
 */
function tokenMatches(presented: string | undefined, token: string): boolean {
  if (!presented || !token) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(token, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** One cookie out of a raw `Cookie` header. */
function cookieValue(raw: string | undefined, name: string): string | undefined {
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/** Pure decision function — the middleware is a thin wrapper over this. */
export function checkRequest(facts: RequestFacts, opts: GuardOptions): GuardVerdict {
  const port = opts.port;
  const lan = opts.lan ?? null;
  const loopback = isAllowedHost(facts.host, port);
  const fromLan = !loopback && lan !== null && isLanHost(facts.host, port, lan.hosts);

  if (!loopback && !fromLan) {
    return {
      ok: false,
      status: 403,
      code: "forbidden_host",
      message:
        `Refusing a request with Host "${facts.host ?? "(none)"}". ` +
        `This server only answers to localhost:${port}.`,
    };
  }

  // Loopback is exempt: it is the machine the server runs on, which is the
  // property the token exists to replace for everyone else.
  if (fromLan && lan) {
    const params = new URLSearchParams(facts.search ?? "");
    const queryToken = params.get("token");
    if (queryToken !== null && facts.method.toUpperCase() === "GET") {
      if (!tokenMatches(queryToken, lan.token)) return unauthorized();
      // Everything but the token survives the redirect, so a deep link from a
      // QR code lands where it was pointing.
      params.delete("token");
      const rest = params.toString();
      const path = facts.path ?? "/";
      return { ok: true, bootstrap: { token: lan.token, location: rest ? `${path}?${rest}` : path } };
    }
    const presented = cookieValue(facts.cookie, TOKEN_COOKIE) ?? facts.tokenHeader;
    if (!tokenMatches(presented, lan.token)) return unauthorized();
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

  const allowed = new Set([
    ...ownOrigins(port),
    ...(lan ? lanOrigins(lan.hosts, port) : []),
    ...(opts.devOrigins ?? DEFAULT_DEV_ORIGINS),
  ]);
  if (allowed.has(origin)) return OK;

  return {
    ok: false,
    status: 403,
    code: "forbidden_origin",
    message:
      `Refusing a ${facts.method} from origin "${origin}". ` +
      `Only the app's own origin may change state; add trusted dev origins to ` +
      `~/.purview/config.json under "devOrigins".`,
  };
}

function unauthorized(): GuardVerdict {
  return {
    ok: false,
    status: 401,
    code: "unauthorized",
    message:
      "This device is not authorised for network access to Purview. " +
      "Scan the current QR code from Purview's own Settings to get in.",
  };
}

/** What the guard reads a request's Host as — the header, or the URL in-process. */
function factsOf(c: Context): RequestFacts {
  // @hono/node-server builds the request URL from the Host header, so the two
  // agree over a real socket; the URL fallback is for in-process clients
  // (tests, `app.request`) where fetch never materialises a Host header.
  let url: URL | undefined;
  try {
    url = new URL(c.req.url);
  } catch {
    url = undefined;
  }
  return {
    method: c.req.method,
    host: c.req.header("host") ?? url?.host,
    origin: c.req.header("origin"),
    secFetchSite: c.req.header("sec-fetch-site"),
    path: url?.pathname ?? "/",
    search: url?.search,
    cookie: c.req.header("cookie"),
    tokenHeader: c.req.header(TOKEN_HEADER),
  };
}

/** The 401 body, in whichever form the caller can read. */
function denied(c: Context, verdict: GuardVerdict) {
  const status = verdict.status ?? 403;
  if (c.req.path.startsWith("/api/")) {
    return c.json({ error: verdict.code, detail: verdict.message }, status);
  }
  // A navigation gets a page instead of a JSON blob. Deliberately bare: it is
  // served before any authentication, so it must not leak the token, the app's
  // shell, or anything else worth having.
  return c.html(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
      `<title>Purview — not authorised</title>` +
      `<body style="font:16px/1.5 system-ui;margin:3rem auto;max-width:28rem;padding:0 1rem">` +
      `<h1 style="font-size:1.1rem">Not authorised</h1>` +
      `<p>This device needs the current Purview QR code. Open Purview on the machine ` +
      `running it, go to Settings &rarr; Network access, and scan the code shown there.</p>` +
      `</body>`,
    status,
  );
}

/**
 * Hono middleware form. Replaces the previous permissive CORS middleware
 * outright: a same-origin app needs no CORS headers, and emitting none is what
 * keeps a foreign page from reading any response it manages to trigger.
 */
export function localOnlyGuard(opts: GuardOptions): MiddlewareHandler {
  return async (c, next) => {
    const verdict = checkRequest(factsOf(c), opts);
    if (verdict.bootstrap) {
      // No `Secure`: this is plain HTTP on a LAN, and a Secure cookie would
      // simply never be stored. HttpOnly + SameSite=Strict are what is left.
      c.header(
        "Set-Cookie",
        `${TOKEN_COOKIE}=${encodeURIComponent(verdict.bootstrap.token)}; Path=/; HttpOnly; SameSite=Strict`,
      );
      return c.redirect(verdict.bootstrap.location, 302);
    }
    if (!verdict.ok) return denied(c, verdict);
    return next();
  };
}

/**
 * Loopback-only, whatever LAN mode says. The QR code and the URL it encodes
 * carry the token in cleartext, so they are for the machine running the server
 * and nothing else: a LAN client that already holds the token must not be able
 * to read it back, and one that does not must not be able to fetch it.
 */
export function loopbackOnly(opts: Pick<GuardOptions, "port">): MiddlewareHandler {
  return async (c, next) => {
    const facts = factsOf(c);
    if (!isAllowedHost(facts.host, opts.port)) {
      return c.json(
        {
          error: "loopback_only",
          detail: "This endpoint is only served to the machine Purview runs on.",
        },
        403,
      );
    }
    return next();
  };
}
