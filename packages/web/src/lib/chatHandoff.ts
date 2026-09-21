/**
 * "Continue in Claude Code": the pure half. The panel owns the popover; this
 * owns when the button is usable and how the command reaches the clipboard.
 */

/**
 * Hostnames the server treats as the machine itself (mirrors `isAllowedHost`
 * in server/security.ts). Anything else is a LAN device, where the hand-off
 * route is refused and its command would not run anyway.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

export const HANDOFF_LAN_REASON = "Run this from the Mac running Purview";

/** Why the button is disabled, or `null` when it is usable. First reason wins. */
export function handoffDisabledReason(input: {
  messageCount: number;
  busy: boolean;
  loopback: boolean;
}): string | null {
  if (!input.loopback) return HANDOFF_LAN_REASON;
  if (input.busy) return "Wait for Claude to finish replying";
  if (input.messageCount === 0) return "Send a message first — there is no conversation to continue yet";
  return null;
}

/**
 * Copy text, falling back to a hidden textarea + `execCommand("copy")` where
 * the async clipboard API is missing (insecure origins) or refuses. Resolves
 * to whether either path reported success.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.top = "-1000px";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}
