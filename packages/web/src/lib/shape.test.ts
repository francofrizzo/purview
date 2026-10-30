import { describe, expect, it } from "vitest";
import { noteFor } from "./shape";

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
