import { describe, expect, it } from "vitest";
import { asideFiles, fileTree, noteFor, type TreeLine } from "./shape";

const show = (lines: TreeLine[]) =>
  lines.map(
    (l) =>
      l.guides.map((continues) => (continues ? "│   " : "    ")).join("") +
      (l.depth ? (l.last ? "└── " : "├── ") : "") +
      (l.status === "added" ? "+" : "") +
      l.name +
      (l.dir ? "/" : "") +
      (l.folded ? ` (${l.folded})` : "") +
      (l.more ? ` (+${l.more})` : "") +
      (l.note ? ` # ${l.note}` : ""),
  );

describe("fileTree", () => {
  it("draws a noted folder as one line, with only its new and noted files under it", () => {
    const lines = fileTree(
      [
        { path: "internal/storage/storage.go", status: "modified" },
        { path: "internal/storage/queries.sql", status: "modified" },
        { path: "internal/storage/migrations/0042_expired.sql", status: "added" },
        { path: "internal/engine/engine.go", status: "modified" },
        { path: "internal/engine/age.go", status: "added" },
        { path: "internal/engine/metrics.go", status: "modified" },
      ],
      { "internal/storage": "Stores and reads the expired state.", "internal/engine/engine.go": "Expires aged-out notices first." },
    );
    expect(show(lines)).toEqual([
      "internal/",
      "├── engine/ (+1)",
      "│   ├── +age.go",
      "│   └── engine.go # Expires aged-out notices first.",
      "└── storage/ # Stores and reads the expired state.",
      "    └── +migrations/0042_expired.sql",
    ]);
  });

  it("puts a folder's lone file on its line, and folds a quiet top-level folder into a count", () => {
    const lines = fileTree(
      [
        { path: "internal/handlers/groups.go", status: "modified" },
        { path: "internal/models/state.go", status: "modified" },
        { path: "frontend/src/client/types.ts", status: "modified" },
        { path: "frontend/src/components/main/groups.tsx", status: "modified" },
        { path: "scripts/life/publish.sql", status: "modified" },
        { path: "tools/a.go", status: "modified" },
        { path: "tools/b.go", status: "modified" },
        { path: "go.mod", status: "modified" },
      ],
      {
        "internal/handlers/groups.go": "Exposes the expired count.",
        "frontend/src/components/main/groups.tsx": "The To review filter.",
        "scripts/life/publish.sql": "A 14-day window.",
      },
    );
    expect(show(lines)).toEqual([
      "frontend/src/ (+1)",
      "└── components/main/groups.tsx # The To review filter.",
      "internal/ (+1)",
      "└── handlers/groups.go # Exposes the expired count.",
      "scripts/life/publish.sql # A 14-day window.",
      "tools/ (2)",
      "go.mod",
    ]);
  });

  it("leaves tests and docs to the foot unless the analysis noted one", () => {
    const lines = fileTree(
      [
        { path: "src/a.ts", status: "added" },
        { path: "src/a.test.ts", status: "added" },
        { path: "docs/a.md", status: "modified" },
        { path: "docs/agent.md", status: "modified" },
      ],
      { "docs/agent.md": "Tells the agent where expired ones show." },
      new Set(["src/a.test.ts", "docs/a.md", "docs/agent.md"]),
    );
    expect(show(lines)).toEqual(["docs/agent.md # Tells the agent where expired ones show.", "+src/a.ts"]);
  });
});

describe("asideFiles", () => {
  it("is the files only tests and docs units read", () => {
    const files = [
      { path: "a.ts", hunks: [{ id: "h1" }, { id: "h2" }] },
      { path: "a.test.ts", hunks: [{ id: "h3" }] },
      { path: "README.md", hunks: [{ id: "h4" }] },
    ];
    const units = [
      { kind: "core-logic" as const, hunks: [{ id: "h1" }] },
      { kind: "tests" as const, hunks: [{ id: "h2" }, { id: "h3" }] },
      { kind: "docs" as const, hunks: [{ id: "h4" }] },
    ];
    expect([...asideFiles(files as never, units as never)].sort()).toEqual(["README.md", "a.test.ts"]);
  });
});

describe("noteFor", () => {
  it("is the file's own note, else the nearest folder's", () => {
    const notes = { internal: "outer", "internal/storage": "inner", "internal/storage/x.go": "own" };
    expect(noteFor(notes, "internal/storage/x.go")).toBe("own");
    expect(noteFor(notes, "internal/storage/sql/y.sql")).toBe("inner");
    expect(noteFor(notes, "internal/z.go")).toBe("outer");
    expect(noteFor(notes, "web/z.ts")).toBeUndefined();
    expect(noteFor(undefined, "web/z.ts")).toBeUndefined();
  });
});
