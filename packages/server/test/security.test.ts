import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keyToString, setGhRunner } from "@reviewer/core";
import { createApp } from "../src/app.js";
import { checkRequest, isAllowedHost, ownOrigins } from "../src/security.js";
import { buildFixture, key } from "./fixtures.js";

const PORT = 4779;
const encodedKey = encodeURIComponent(keyToString(key));
const OWN = `http://localhost:${PORT}`;

const facts = (over: Partial<Parameters<typeof checkRequest>[0]> = {}) => ({
  method: "POST",
  host: `localhost:${PORT}`,
  origin: undefined,
  secFetchSite: undefined,
  ...over,
});

/* -------------------------------------------------------- pure host checks */

describe("isAllowedHost", () => {
  it("accepts loopback names on the configured port", () => {
    expect(isAllowedHost(`localhost:${PORT}`, PORT)).toBe(true);
    expect(isAllowedHost(`127.0.0.1:${PORT}`, PORT)).toBe(true);
    expect(isAllowedHost(`[::1]:${PORT}`, PORT)).toBe(true);
  });

  it("accepts a loopback name with no port (non-browser clients)", () => {
    expect(isAllowedHost("localhost", PORT)).toBe(true);
  });

  it("rejects a foreign hostname even when it resolves to loopback", () => {
    // This is the DNS-rebinding case: the attacker controls DNS but not Host.
    expect(isAllowedHost(`evil.example:${PORT}`, PORT)).toBe(false);
    expect(isAllowedHost("localtest.me", PORT)).toBe(false);
  });

  it("rejects a loopback name on someone else's port", () => {
    expect(isAllowedHost("localhost:8080", PORT)).toBe(false);
  });

  it("rejects a missing or unparseable Host", () => {
    expect(isAllowedHost(undefined, PORT)).toBe(false);
    expect(isAllowedHost("", PORT)).toBe(false);
  });
});

/* ------------------------------------------------------ pure origin checks */

describe("checkRequest", () => {
  it("passes a POST with no Origin at all (curl, the CLI)", () => {
    expect(checkRequest(facts(), { port: PORT }).ok).toBe(true);
  });

  it("passes a POST from the app's own origin, in both spellings", () => {
    for (const origin of ownOrigins(PORT)) {
      expect(checkRequest(facts({ origin }), { port: PORT }).ok).toBe(true);
    }
  });

  it("blocks a POST from a foreign origin", () => {
    const v = checkRequest(facts({ origin: "https://evil.example" }), { port: PORT });
    expect(v.ok).toBe(false);
    expect(v.code).toBe("forbidden_origin");
    expect(v.status).toBe(403);
  });

  it("blocks a POST the browser labels cross-site even without an Origin", () => {
    const v = checkRequest(facts({ secFetchSite: "cross-site" }), { port: PORT });
    expect(v.ok).toBe(false);
    expect(v.code).toBe("forbidden_origin");
  });

  it("passes a POST the browser labels same-origin", () => {
    expect(
      checkRequest(facts({ origin: OWN, secFetchSite: "same-origin" }), { port: PORT }).ok,
    ).toBe(true);
  });

  it("passes a configured dev origin (the Vite proxy forwards it)", () => {
    const opts = { port: PORT, devOrigins: ["http://localhost:5179"] };
    expect(checkRequest(facts({ origin: "http://localhost:5179" }), opts).ok).toBe(true);
    // ...and only the configured one.
    expect(checkRequest(facts({ origin: "http://localhost:9999" }), opts).ok).toBe(false);
  });

  it("blocks any method when the Host is foreign", () => {
    for (const method of ["GET", "POST", "DELETE"]) {
      const v = checkRequest(facts({ method, host: "evil.example" }), { port: PORT });
      expect(v.ok).toBe(false);
      expect(v.code).toBe("forbidden_host");
    }
  });

  it("lets a GET through from a foreign origin", () => {
    // Deliberate: a GET mutates nothing, and the absence of CORS headers means
    // the attacking page still cannot read the response. Blocking it would only
    // break plain browser navigation.
    expect(
      checkRequest(facts({ method: "GET", origin: "https://evil.example" }), { port: PORT }).ok,
    ).toBe(true);
  });
});

/* ------------------------------------------------------------- end-to-end */

describe("the guard on a live app", () => {
  let root: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-security-test-"));
    buildFixture(root);
    app = createApp({
      stateDir: root,
      webDist: path.join(root, "__no-web-dist__"),
      port: PORT,
      devOrigins: ["http://localhost:5179"],
    });
  });

  afterEach(() => {
    setGhRunner(null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const post = (origin?: string, extra: Record<string, string> = {}) =>
    app.request(`http://localhost:${PORT}/api/prs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(origin ? { Origin: origin } : {}),
        ...extra,
      },
      body: JSON.stringify({}),
    });

  it("403s a state-changing request from a foreign origin", async () => {
    const res = await post("https://evil.example");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("forbidden_origin");
  });

  it("lets the same request through from the app's own origin", async () => {
    // 400 (missing url) rather than 403: it got past the guard to the handler.
    expect((await post(OWN)).status).toBe(400);
  });

  it("lets the configured dev origin through", async () => {
    expect((await post("http://localhost:5179")).status).toBe(400);
  });

  it("403s a foreign Host on a GET", async () => {
    const res = await app.request(`http://localhost:${PORT}/api/prs`, {
      headers: { Host: "evil.example" },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("forbidden_host");
  });

  it("serves a GET carrying a foreign Origin, with no CORS headers on it", async () => {
    const res = await app.request(`http://localhost:${PORT}/api/prs/${encodedKey}`, {
      headers: { Origin: "https://evil.example" },
    });
    expect(res.status).toBe(200);
    // The point of dropping the CORS middleware: nothing here lets that page
    // read the body it just triggered.
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("blocks the review-submit path, which confirm:true cannot protect", async () => {
    const res = await app.request(
      `http://localhost:${PORT}/api/prs/${encodedKey}/review/submit`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
        body: JSON.stringify({ event: "APPROVE", confirm: true }),
      },
    );
    expect(res.status).toBe(403);
  });
});
