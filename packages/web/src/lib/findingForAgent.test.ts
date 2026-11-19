import { describe, expect, it } from "vitest";
import { findingForAgent } from "./findingForAgent";

describe("findingForAgent", () => {
  it("gives the finding, where it was read, its change and the ask", () => {
    const text = findingForAgent(
      { severity: "warning", text: "`handleRefund` ignores `ErrRateLimited`", evidence: "internal/billing/refund.go:212" },
      "Refunds retry on rate limits",
    );
    expect(text).toBe(
      "A possible problem a review of this PR found by reading the code. Check it: fix it if it holds, or explain why it does not.\n\n" +
        "### `handleRefund` ignores `ErrRateLimited`\n\n" +
        "Where: internal/billing/refund.go:212\n\n" +
        "In the change: Refunds retry on rate limits\n",
    );
  });
});
