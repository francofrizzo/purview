import { afterEach, describe, expect, it } from "vitest";
import { searchOwnPrs, searchOwnPrsAsync, setGhRunner } from "../src/github.js";

afterEach(() => setGhRunner(null));

describe("own PR search", () => {
  for (const search of [searchOwnPrs, searchOwnPrsAsync]) {
    it(`${search.name} queries every author and deduplicates PR numbers`, async () => {
      const calls: string[][] = [];
      setGhRunner((args) => {
        calls.push(args);
        return JSON.stringify([{ number: 1, title: "Draft", updatedAt: "2024-01-05" },
          ...(calls.length === 2 ? [{ number: 2, title: "Other", updatedAt: "2024-01-05" }] : [])]);
      });
      const result = await search({ host: "github.com", owner: "acme", repo: "widgets" }, "2024-01-04T12:30:00Z", ["Helper", "helper", ""]);
      expect(result.map((pr) => pr.number)).toEqual([1, 2]);
      expect(calls).toEqual(["@me", "helper"].map((login) => [
        "pr", "list", "-R", "acme/widgets", "--search", `author:${login} updated:>=2024-01-04`,
        "--state", "open", "--json", "number,title,updatedAt,author", "--limit", "100",
      ]));
    });
  }
});
