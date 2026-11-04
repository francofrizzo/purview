import { describe, expect, it } from "vitest";
import { isSafeDiagram } from "./unitDiagram";

const seq = "sequenceDiagram\n  Client->>API: charge\n  API-->>Client: result";

describe("isSafeDiagram", () => {
  it("takes the four diagram types the analysis may write", () => {
    expect(isSafeDiagram(seq)).toBe(true);
    expect(isSafeDiagram("stateDiagram-v2\n  [*] --> Pending")).toBe(true);
    expect(isSafeDiagram("%% note\nflowchart LR\n  A[amount < limit] --> B[once<br/>only]")).toBe(true);
    expect(isSafeDiagram("erDiagram\n  ORDER ||--o{ CHARGE : has")).toBe(true);
  });

  it("refuses other types, oversized source and every directive the server refuses", () => {
    for (const src of [
      "",
      "classDiagram\n  A <|-- B",
      "pie\n  \"a\": 1",
      seq + "\n" + "%".repeat(3000),
      "%%{init: {'securityLevel': 'loose'}}%%\n" + seq,
      "flowchart LR\n  A --> B\n  click A callback",
      "flowchart LR\n  A --> B\n  style A fill:#f00",
      "flowchart LR\n  A --> B\n  linkStyle 0 stroke:red",
      "flowchart LR\n  A --> B\n  classDef x fill:red",
      "flowchart LR\n  A:::x --> B",
      "flowchart LR\n  A[<script>alert(1)</script>] --> B",
      "flowchart LR\n  A[<img src=x onerror=alert(1)>] --> B",
      'flowchart LR\n  A["javascript:alert(1)"] --> B',
      seq + "\n  link API: Docs @ https://example.com",
    ]) {
      expect(isSafeDiagram(src), src).toBe(false);
    }
  });
});
