import { describe, expect, it } from "vitest";
import { HANDOFF_LAN_REASON, handoffDisabledReason, isLoopbackHostname } from "./chatHandoff";

describe("isLoopbackHostname", () => {
  it("accepts the loopback names the server accepts", () => {
    for (const h of ["localhost", "LOCALHOST", "127.0.0.1", "[::1]", "::1"]) {
      expect(isLoopbackHostname(h), h).toBe(true);
    }
  });

  it("rejects LAN addresses and names", () => {
    for (const h of ["192.168.1.24", "macbook.local", "10.0.0.5", "127.0.0.1.nip.io"]) {
      expect(isLoopbackHostname(h), h).toBe(false);
    }
  });
});

describe("handoffDisabledReason", () => {
  const ok = { busy: false, loopback: true };

  it("is enabled when idle, on the Mac, even before the first message", () => {
    expect(handoffDisabledReason(ok)).toBeNull();
  });

  it("explains a streaming turn", () => {
    expect(handoffDisabledReason({ ...ok, busy: true })).toMatch(/reply to finish/);
  });

  it("names the LAN case first: nothing else would make it usable there", () => {
    expect(handoffDisabledReason({ busy: true, loopback: false })).toBe(
      HANDOFF_LAN_REASON,
    );
    expect(HANDOFF_LAN_REASON).toBe("Run this from the Mac running Purview");
  });
});
