import { describe, expect, it } from "vitest";
import { ApiError } from "../api/errors";
import { rollbackMessage } from "./rollback";

describe("rollbackMessage", () => {
  it("is nothing while every source is clean", () => {
    expect(rollbackMessage([{ label: "archiving", error: null }, { label: "marking viewed", error: undefined }])).toBeNull();
  });

  it("names what failed, why, and that the screen was put back", () => {
    const msg = rollbackMessage([
      { label: "marking the hunk viewed", error: null },
      { label: "archiving the PR", error: new ApiError("not_found", 404, { error: "not_found", detail: "No PR \"x\"" }) },
    ]);
    expect(msg).toBe('Archiving the PR failed: No PR "x". The change was put back.');
  });

  it("reports the first failure when several are set", () => {
    const msg = rollbackMessage([
      { label: "reclassifying the unit", error: new Error("disk full") },
      { label: "archiving the PR", error: new Error("later") },
    ]);
    expect(msg).toMatch(/^Reclassifying the unit failed: disk full/);
  });
});
