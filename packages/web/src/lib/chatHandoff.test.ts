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
  const ok = { messageCount: 2, busy: false, loopback: true };

  it("is enabled with a conversation, idle, on the Mac", () => {
    expect(handoffDisabledReason(ok)).toBeNull();
  });

  it("explains an empty conversation", () => {
    expect(handoffDisabledReason({ ...ok, messageCount: 0 })).toMatch(/Send a message first/);
  });

  it("explains a streaming turn", () => {
    expect(handoffDisabledReason({ ...ok, busy: true })).toMatch(/finish replying/);
  });

  it("names the LAN case first: nothing else would make it usable there", () => {
    expect(handoffDisabledReason({ messageCount: 0, busy: true, loopback: false })).toBe(
      HANDOFF_LAN_REASON,
    );
    expect(HANDOFF_LAN_REASON).toBe("Run this from the Mac running Purview");
  });
});
