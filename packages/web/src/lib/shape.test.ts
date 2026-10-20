import { describe, expect, it } from "vitest";
import { fileTree, flowRows } from "./shape";

describe("fileTree", () => {
  it("draws directories first, folds single-directory chains, and puts each note on its file", () => {
    const lines = fileTree(
      [
        { path: "apps/api/src/services/onboarding/onboarding.service.ts", status: "added" },
        { path: "apps/api/src/services/onboarding/onboarding-config.ts", status: "added" },
        { path: "apps/api/src/services/resend/resend.service.ts", status: "modified" },
        { path: "README.md", status: "modified" },
      ],
      { "apps/api/src/services/onboarding/onboarding.service.ts": "Effect tag + live layer" },
    );
    expect(lines.map((l) => l.prefix + l.name)).toEqual([
      "apps/api/src/services",
      "├── onboarding",
      "│   ├── onboarding-config.ts",
      "│   └── onboarding.service.ts",
      "└── resend",
      "    └── resend.service.ts",
      "README.md",
    ]);
    expect(lines.find((l) => l.name === "onboarding.service.ts")).toMatchObject({
      dir: false,
      status: "added",
      note: "Effect tag + live layer",
    });
    expect(lines[0].dir).toBe(true);
  });

  it("folds a quiet directory into one line, and keeps one with anything new or noted open", () => {
    const lines = fileTree(
      [
        { path: "integrationtests/a_test.go", status: "modified" },
        { path: "integrationtests/b_test.go", status: "modified" },
        { path: "internal/engine.go", status: "modified" },
        { path: "internal/tools.go", status: "modified" },
        { path: "docs/AGENTS.md", status: "added" },
        { path: "docs/old.md", status: "modified" },
      ],
      { "internal/engine.go": "Builds one associator per run." },
    );
    expect(lines.map((l) => l.prefix + l.name + (l.folded ? ` (${l.folded})` : ""))).toEqual([
      "docs",
      "├── AGENTS.md",
      "└── old.md",
      "integrationtests (2)",
      "internal",
      "├── engine.go",
      "└── tools.go",
    ]);
  });
});

describe("flowRows", () => {
  it("puts each phase band right before the step it starts at, and ignores one past the end", () => {
    const rows = flowRows({
      steps: [0, 1, 2, 3].map(() => ({}) as never),
      phases: [
        { label: "Load", at: 0 },
        { label: "Drill in", at: 2 },
        { label: "Never", at: 9 },
      ],
    });
    expect(rows).toEqual([
      { kind: "phase", label: "Load" },
      { kind: "step", index: 0 },
      { kind: "step", index: 1 },
      { kind: "phase", label: "Drill in" },
      { kind: "step", index: 2 },
      { kind: "step", index: 3 },
    ]);
  });
});
