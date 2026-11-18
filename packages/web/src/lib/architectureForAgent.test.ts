import { describe, expect, it } from "vitest";
import type { ArchitectureDeviation } from "../api/types";
import { architectureForAgent, deviationForAgent } from "./architectureForAgent";

const deviation: ArchitectureDeviation = {
  what: "Reconciler queries the ledger table itself",
  rule: { source: "docs/architecture.md", heading: "Persistence", quote: "Only `ledger.ts` writes `charge_ledger`." },
  code: { unit: "reconcile", file: "src/billing/reconcile.ts", line: 114, excerpt: "const x = \"```\";" },
  why: "Ledger has no paged read.",
};

describe("architecture for an agent", () => {
  it("gives one deviation with the rule quoted, the place, the code and what to do", () => {
    const text = deviationForAgent(deviation);
    expect(text).toContain("may break. Check it against the code");
    expect(text).toContain("### Reconciler queries the ledger table itself");
    expect(text).toContain("`src/billing/reconcile.ts:114` may break this rule from `docs/architecture.md` (Persistence):");
    expect(text).toContain("> Only `ledger.ts` writes `charge_ledger`.");
    // A fence longer than the backticks inside the code.
    expect(text).toContain("````\nconst x = \"```\";\n````");
    expect(text).toContain("Ledger has no paged read.");
  });

  it("gives the whole view: the deviations, then the decisions with their doc line", () => {
    const text = architectureForAgent({
      sources: ["docs/architecture.md"],
      deviations: [deviation],
      decisions: [{ what: "Jobs read the gateway in batches", means: "The job pages.", docLine: { target: "docs/architecture.md", heading: "Gateway", text: "Jobs may batch." } }],
    });
    expect(text.indexOf("## Possible architecture deviations")).toBeLessThan(text.indexOf("## Worth documenting"));
    expect(text).toContain("Rules from `docs/architecture.md` this PR may break.");
    expect(text).toContain('- **Jobs read the gateway in batches**: The job pages. Suggested line for `docs/architecture.md`, under "Gateway": "Jobs may batch."');
  });
});
