import { describe, expect, it } from "vitest";
import { commonRiskFlags } from "./risks";

const u = (...riskFlags: string[]) => ({ riskFlags }) as { riskFlags: never[] };

describe("commonRiskFlags", () => {
  it("is a flag on at least a third of the units read closely", () => {
    // core#9355's must-reads: money on 3 of 7 runs through them; auth and migration set one apart.
    const must = [u("money"), u("money"), u("auth"), u("migration"), u(), u("money"), u()];
    expect([...commonRiskFlags(must)]).toEqual(["money"]);
    // core#9161's: money and auth on 4 of 9 each; concurrency on one, migration on two.
    const big = [u("money", "concurrency", "auth"), u("money"), u("auth"), u("money"), u("money", "auth"), u("auth"), u("migration"), u("migration"), u()];
    expect([...commonRiskFlags(big)].sort()).toEqual(["auth", "money"]);
  });

  it("never calls a flag on a single unit common", () => {
    expect([...commonRiskFlags([u("money"), u("concurrency")])]).toEqual([]);
  });
});
