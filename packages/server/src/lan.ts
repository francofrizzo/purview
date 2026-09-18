import os from "node:os";
import QRCode from "qrcode";

/**
 * The names this machine answers to on the local network, and the URL a phone
 * or tablet has to open to reach the server.
 *
 * The interface scan happens once, at startup: the guard consults this list on
 * every request, and re-reading the interfaces per request would be both
 * wasteful and a way for a hot-plugged interface to silently widen the
 * allowlist under a running server.
 */

/**
 * Every non-internal IPv4 of this machine, plus its hostname in both the bare
 * and mDNS (`.local`) spellings — the three ways an iPad actually addresses a
 * Mac on a home network. Lowercased, because `Host` comparison is.
 */
export function lanHostnames(): string[] {
  const names: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      // Node has reported `family` as both "IPv4" and 4 across major versions.
      const v4 = addr.family === "IPv4" || (addr.family as unknown as number) === 4;
      if (v4 && !addr.internal) names.push(addr.address);
    }
  }
  // macOS reports the hostname already in its `.local` form; elsewhere it is
  // bare. Both spellings go in either way, since both are typed at browsers.
  const hostname = os.hostname().toLowerCase().replace(/\.$/, "");
  if (hostname) {
    names.push(hostname);
    names.push(
      hostname.endsWith(".local") ? hostname.slice(0, -".local".length) : `${hostname}.local`,
    );
  }
  return [...new Set(names.map((n) => n.toLowerCase()))];
}

/**
 * The address to hand the other device. The first IPv4 wins over the hostname:
 * `.local` resolution depends on mDNS being allowed on the network, a numeric
 * address never is.
 */
export function lanUrl(hosts: string[], port: number, token: string): string | null {
  const host = hosts[0];
  if (!host) return null;
  return `http://${host}:${port}/?token=${encodeURIComponent(token)}`;
}

/** Block-character QR for the startup log. */
export function lanQrTerminal(url: string): Promise<string> {
  return QRCode.toString(url, { type: "terminal", small: true });
}

/** QR the Settings UI drops straight into the DOM. */
export function lanQrSvg(url: string): Promise<string> {
  return QRCode.toString(url, { type: "svg", margin: 1 });
}

/**
 * The one line every surface repeats. The token is the only thing between the
 * network and a server that can spend Claude credits and write to GitHub, so
 * it is never softened.
 */
export const LAN_WARNING =
  "Anyone on this network who has that URL has full control of this Purview — " +
  "it can spend Claude credits and post to GitHub on your behalf.";
