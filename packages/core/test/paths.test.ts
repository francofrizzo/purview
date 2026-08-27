import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import {
  diffPath,
  filesJsonPath,
  isPrDirName,
  keyToString,
  parseKey,
  parseRepoKey,
  parsePrUrl,
  prDir,
  repoChatInstructionsPath,
  repoConfigPath,
  repoDir,
  repoKeyToString,
  repoRubricPath,
  stateRoot,
  teamConfigPath,
} from "../src/paths.js";

const key = {
  host: "github.com",
  owner: "acme",
  repo: "widgets",
  number: 7,
};

afterEach(() => {
  delete process.env.REVIEWER_STATE_DIR;
  delete process.env.PURVIEW_STATE_DIR;
});

describe("state dir layout", () => {
  it("defaults to ~/.purview", () => {
    expect(stateRoot()).toBe(path.join(os.homedir(), ".purview"));
  });

  it("prefers PURVIEW_STATE_DIR over the legacy REVIEWER_STATE_DIR", () => {
    process.env.REVIEWER_STATE_DIR = "/tmp/legacy";
    expect(stateRoot()).toBe("/tmp/legacy");
    process.env.PURVIEW_STATE_DIR = "/tmp/new";
    expect(stateRoot()).toBe("/tmp/new");
  });

  it("puts repo-level files beside the numbered PR dirs, with no collision", () => {
    process.env.PURVIEW_STATE_DIR = "/tmp/xyz";
    const repo = { host: key.host, owner: key.owner, repo: key.repo };
    expect(repoDir(repo)).toBe("/tmp/xyz/github.com/acme/widgets");
    expect(repoConfigPath(repo)).toBe("/tmp/xyz/github.com/acme/widgets/repo.json");
    expect(repoRubricPath(repo)).toBe(
      "/tmp/xyz/github.com/acme/widgets/RUBRIC.local.md",
    );
    expect(repoChatInstructionsPath(repo)).toBe(
      "/tmp/xyz/github.com/acme/widgets/CHAT.local.md",
    );
    expect(prDir(key)).toBe(`${repoDir(repo)}/7`);
    // Every PR dir name is digits only, so no PR can ever be named repo.json.
    expect(isPrDirName("7")).toBe(true);
    expect(isPrDirName("repo.json")).toBe(false);
    expect(isPrDirName("RUBRIC.local.md")).toBe(false);
    expect(isPrDirName("CHAT.local.md")).toBe(false);
  });

  it("caches the committed team config per revision", () => {
    process.env.PURVIEW_STATE_DIR = "/tmp/xyz";
    expect(teamConfigPath(key, 3)).toBe(
      "/tmp/xyz/github.com/acme/widgets/7/revisions/3/team-config.json",
    );
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

  it("round-trips repo keys and assumes github.com for a 2-part key", () => {
    const repo = { host: "github.com", owner: "acme", repo: "widgets" };
    expect(repoKeyToString(repo)).toBe("github.com/acme/widgets");
    expect(parseRepoKey(repoKeyToString(repo))).toEqual(repo);
    expect(parseRepoKey(encodeURIComponent(repoKeyToString(repo)))).toEqual(repo);
    expect(parseRepoKey("acme/widgets")).toEqual(repo);
    expect(parseRepoKey("git.corp.io/acme/widgets")).toEqual({
      host: "git.corp.io",
      owner: "acme",
      repo: "widgets",
    });
    expect(() => parseRepoKey("nope")).toThrow();
  });

  it("rejects non-PR input", () => {
    expect(() => parsePrUrl("https://github.com/acme/widgets")).toThrow();
    expect(() => parseKey("nope")).toThrow();
  });
});
