import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import {
  diffPath,
  filesJsonPath,
  keyToString,
  parseKey,
  parsePrUrl,
  prDir,
  stateRoot,
} from "../src/paths.js";

const key = {
  host: "github.com",
  owner: "acme",
  repo: "widgets",
  number: 7,
};

afterEach(() => {
  delete process.env.REVIEWER_STATE_DIR;
});

describe("state dir layout", () => {
  it("defaults to ~/.reviewer", () => {
    expect(stateRoot()).toBe(path.join(os.homedir(), ".reviewer"));
  });

  it("is overridable with REVIEWER_STATE_DIR", () => {
    process.env.REVIEWER_STATE_DIR = "/tmp/xyz";
    expect(stateRoot()).toBe("/tmp/xyz");
    expect(prDir(key)).toBe("/tmp/xyz/github.com/acme/widgets/7");
    expect(diffPath(key, 2)).toBe(
      "/tmp/xyz/github.com/acme/widgets/7/revisions/2/diff.patch",
    );
    expect(filesJsonPath(key, 2)).toBe(
      "/tmp/xyz/github.com/acme/widgets/7/revisions/2/files.json",
    );
  });
});

describe("keys", () => {
  it("round-trips host/owner/repo/number", () => {
    expect(parseKey(keyToString(key))).toEqual(key);
    expect(parseKey(encodeURIComponent(keyToString(key)))).toEqual(key);
  });

  it("assumes github.com for a 3-part key", () => {
    expect(parseKey("acme/widgets/7")).toEqual(key);
  });

  it("parses PR urls, including enterprise hosts", () => {
    expect(parsePrUrl("https://github.com/acme/widgets/pull/7")).toEqual(key);
    expect(parseKey("https://github.com/acme/widgets/pull/7#files")).toEqual(key);
    expect(parsePrUrl("https://git.corp.io/acme/widgets/pull/12")).toEqual({
      host: "git.corp.io",
      owner: "acme",
      repo: "widgets",
      number: 12,
    });
  });

  it("rejects non-PR input", () => {
    expect(() => parsePrUrl("https://github.com/acme/widgets")).toThrow();
    expect(() => parseKey("nope")).toThrow();
  });
});
