import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setGhRunner } from "@reviewer/core";
import { createApp } from "../src/app.js";
import { toLines } from "../src/file-content.js";
import { buildFixture, key } from "./fixtures.js";

const encodedKey = encodeURIComponent(`${key.host}/${key.owner}/${key.repo}/${key.number}`);
let root: string;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-file-test-"));
  buildFixture(root);
  app = createApp({ stateDir: root, webDist: "/nonexistent", reviewRequestRefresh: false });
});

afterEach(() => {
  setGhRunner(null);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("GET /api/prs/:key/file", () => {
  it("serves the file at the head as lines, from the contents API without a checkout, cached", async () => {
    const calls: string[][] = [];
    setGhRunner((args) => {
      calls.push(args);
      if (args.some((a) => a.includes("contents/src/widgets.ts?ref="))) return "one\ntwo\n";
      throw new Error("gh: Not Found (HTTP 404)");
    });
    const get = async (p: string) => (await app.request(`/api/prs/${encodedKey}/file?path=${encodeURIComponent(p)}`)).json();
    const first = await get("src/widgets.ts");
    expect(first.lines).toEqual(["one", "two"]);
    expect(typeof first.sha).toBe("string");
    expect(calls.some((a) => a.includes("Accept: application/vnd.github.raw"))).toBe(true);
    const n = calls.length;
    expect((await get("src/widgets.ts")).lines).toEqual(["one", "two"]);
    expect(calls.length).toBe(n);
    expect((await get("src/gone.ts")).lines).toBeNull();
  });

  it("400s without a path", async () => {
    expect((await app.request(`/api/prs/${encodedKey}/file`)).status).toBe(400);
  });
});

describe("toLines", () => {
  it("drops the empty line after a trailing newline and CRs", () => {
    expect(toLines("a\r\nb\n")).toEqual(["a", "b"]);
    expect(toLines("a\n\n")).toEqual(["a", ""]);
    expect(toLines("")).toEqual([]);
  });
});
