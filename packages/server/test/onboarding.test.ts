import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configPath, keyToString, setGhRunner, type GhRunner } from "@reviewer/core";
import { createApp } from "../src/app.js";
import { analysisIdle } from "../src/analysis.js";
import {
  DEFAULT_DEV_ORIGINS,
  configExists,
  readConfig,
  resolveAutoAnalyze,
  writeConfig,
} from "../src/config.js";
import {
  checkClaude,
  checkGh,
  checkNode,
  checkStateDir,
  makePalette,
  colorsEnabled,
  parseYesNo,
  renderBanner,
  renderSummary,
  runOnboarding,
  shouldOnboard,
  stripAnsi,
  type Exec,
  type OnboardingIo,
} from "../src/onboarding.js";
import { key, REV1_PATCH } from "./fixtures.js";
import { fakeClaude, type FakeClaude } from "./fake-claude.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-onboarding-test-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/* --------------------------------------------------------- an injectable io */

interface FakeIo extends OnboardingIo {
  output: string;
  asked: string[];
}

/** Answers prompts from a queue; an exhausted queue means "just press enter". */
function fakeIo(answers: string[] = []): FakeIo {
  const queue = [...answers];
  const io: FakeIo = {
    output: "",
    asked: [],
    write(text) {
      io.output += text;
    },
    async question(prompt) {
      io.asked.push(prompt);
      return queue.shift() ?? "";
    },
    close() {},
  };
  return io;
}

/** Exec stub: maps "cmd arg arg" to a result; anything unmapped fails. */
function fakeExec(table: Record<string, { ok?: boolean; stdout?: string; stderr?: string }>): Exec {
  return (cmd, args) => {
    const hit = table[[cmd, ...args].join(" ")];
    if (!hit) return { ok: false, stdout: "", stderr: "command not found" };
    return { ok: hit.ok ?? true, stdout: hit.stdout ?? "", stderr: hit.stderr ?? "" };
  };
}

const HEALTHY = {
  "gh --version": { stdout: "gh version 2.63.2 (2024-12-05)" },
  "gh auth status": { stdout: "github.com\n  ✓ Logged in to github.com account octocat (keyring)" },
  "claude --version": { stdout: "2.0.14 (Claude Code)" },
};

/* ------------------------------------------------------------ skip decision */

describe("shouldOnboard", () => {
  it("onboards on a first run in a terminal", () => {
    expect(shouldOnboard({ root, isTty: true })).toEqual({ onboard: true });
  });

  it("skips when config.json already exists", () => {
    writeConfig({ autoAnalyze: true }, root);
    expect(shouldOnboard({ root, isTty: true })).toEqual({
      onboard: false,
      reason: "config-exists",
    });
  });

  it("skips when stdout is not a TTY, even on a first run", () => {
    expect(shouldOnboard({ root, isTty: false })).toEqual({
      onboard: false,
      reason: "not-a-tty",
    });
  });

  it("--onboard forces a re-run past both skip conditions", () => {
    writeConfig({ autoAnalyze: true }, root);
    expect(shouldOnboard({ root, isTty: false, force: true })).toEqual({ onboard: true });
  });
});

/* ------------------------------------------------------------------ checks */

describe("environment checks", () => {
  it("classifies the Node version by major", () => {
    expect(checkNode("v20.11.1").status).toBe("pass");
    expect(checkNode("v24.0.0").status).toBe("pass");
    const old = checkNode("v18.19.0");
    expect(old.status).toBe("fail");
    expect(old.hint).toMatch(/nodejs\.org/);
  });

  it("passes gh and reports the detected login", () => {
    const r = checkGh(fakeExec(HEALTHY));
    expect(r.status).toBe("pass");
    expect(r.detail).toBe("logged in as octocat");
  });

  it("reads the login out of gh's stderr too", () => {
    const r = checkGh(
      fakeExec({
        "gh --version": { stdout: "gh version 2.63.2" },
        "gh auth status": { stderr: "github.com\n  ✓ Logged in to github.com as hubot (oauth)" },
      }),
    );
    expect(r.detail).toBe("logged in as hubot");
  });

  it("fails gh when it is missing, and points at the install page", () => {
    const r = checkGh(fakeExec({}));
    expect(r.status).toBe("fail");
    expect(r.detail).toBe("not found");
    expect(r.hint).toMatch(/cli\.github\.com/);
  });

  it("fails gh when installed but not authenticated, and gives the command", () => {
    const r = checkGh(
      fakeExec({
        "gh --version": { stdout: "gh version 2.63.2" },
        "gh auth status": { ok: false, stderr: "You are not logged into any GitHub hosts." },
      }),
    );
    expect(r.status).toBe("fail");
    expect(r.hint).toBe("Authenticate with: gh auth login");
  });

  it("only warns when claude is missing — it is optional", () => {
    const r = checkClaude(fakeExec({}));
    expect(r.status).toBe("warn");
    expect(r.hint).toMatch(/claude-code/);
  });

  it("passes claude and reports the version line", () => {
    expect(checkClaude(fakeExec(HEALTHY))).toMatchObject({
      status: "pass",
      detail: "2.0.14 (Claude Code)",
    });
  });

  it("passes the state dir when it is writable, creating it if needed", () => {
    const target = path.join(root, "nested", "state");
    expect(checkStateDir(target).status).toBe("pass");
    expect(fs.existsSync(target)).toBe(true);
  });

  it("fails the state dir when it cannot be created", () => {
    const file = path.join(root, "not-a-dir");
    fs.writeFileSync(file, "");
    const r = checkStateDir(path.join(file, "state"));
    expect(r.status).toBe("fail");
    expect(r.hint).toMatch(/REVIEWER_STATE_DIR/);
  });
});

/* ------------------------------------------------------------- presentation */

describe("rendering", () => {
  it("disables color under NO_COLOR and off a TTY", () => {
    expect(colorsEnabled({ NO_COLOR: "1" }, true)).toBe(false);
    expect(colorsEnabled({}, false)).toBe(false);
    expect(colorsEnabled({}, true)).toBe(true);
    expect(colorsEnabled({ NO_COLOR: "" }, true)).toBe(true);
  });

  it("emits no escape sequences when color is off", () => {
    const plain = renderBanner(makePalette(false));
    expect(plain).toBe(stripAnsi(plain));
    expect(plain).toContain("P U R V I E W");
  });

  it("keeps the banner box square", () => {
    const lines = stripAnsi(renderBanner(makePalette(true))).split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(new Set(lines.map((l) => [...l].length)).size).toBe(1);
  });

  it("aligns the summary box regardless of content width", () => {
    const box = stripAnsi(
      renderSummary({ root: "/a/very/long/state/dir", port: 4779, claudeReady: true, autoAnalyze: true }, makePalette(true)),
    );
    const lines = box.split("\n");
    expect(new Set(lines.map((l) => [...l].length)).size).toBe(1);
    expect(box).toContain("http://localhost:4779");
    expect(box).toContain("pr-review skill");
  });

  it("says so in the summary when claude is unavailable", () => {
    const box = renderSummary(
      { root, port: 4779, claudeReady: false, autoAnalyze: false },
      makePalette(false),
    );
    expect(box).toContain("no claude CLI");
    expect(box).toContain("manual only");
  });
});

describe("parseYesNo", () => {
  it("takes the fallback on an empty answer", () => {
    expect(parseYesNo("", true)).toBe(true);
    expect(parseYesNo("  ", false)).toBe(false);
  });

  it("reads y/yes/n/no case-insensitively, treating anything else as no", () => {
    expect(parseYesNo("Y", false)).toBe(true);
    expect(parseYesNo("yes", false)).toBe(true);
    expect(parseYesNo("n", true)).toBe(false);
    expect(parseYesNo("nope", true)).toBe(false);
    expect(parseYesNo("maybe", true)).toBe(false);
  });
});

/* -------------------------------------------------------------------- flow */

describe("runOnboarding", () => {
  it("writes the config with the consent answer and an onboardedAt", async () => {
    const io = fakeIo([""]); // default Y
    const result = await runOnboarding({
      root,
      port: 4779,
      io,
      exec: fakeExec(HEALTHY),
      palette: makePalette(false),
      nodeVersion: "v22.1.0",
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });
    expect(result.aborted).toBe(false);
    expect(result.config).toMatchObject({
      autoAnalyze: true,
      onboardedAt: "2026-01-02T03:04:05.000Z",
      devOrigins: DEFAULT_DEV_ORIGINS,
    });
    expect(configExists(root)).toBe(true);
    expect(readConfig(root).autoAnalyze).toBe(true);
    expect(JSON.parse(fs.readFileSync(configPath(root), "utf8")).autoAnalyze).toBe(true);
  });

  it("stores a declined consent", async () => {
    const io = fakeIo(["n"]);
    const result = await runOnboarding({
      root,
      port: 4779,
      io,
      exec: fakeExec(HEALTHY),
      palette: makePalette(false),
      nodeVersion: "v22.1.0",
    });
    expect(result.config?.autoAnalyze).toBe(false);
    expect(readConfig(root).autoAnalyze).toBe(false);
  });

  it("explains the cost before asking, and only asks once when everything passes", async () => {
    const io = fakeIo([""]);
    await runOnboarding({
      root,
      port: 4779,
      io,
      exec: fakeExec(HEALTHY),
      palette: makePalette(false),
      nodeVersion: "v22.1.0",
    });
    expect(io.asked).toHaveLength(1);
    expect(io.asked[0]).toMatch(/\[Y\/n\]/);
    expect(io.output).toContain("your own Claude account");
    expect(io.output).toContain("logged in as octocat");
    expect(io.output).toMatch(/✓ Node\.js >= 20/);
  });

  it("stops on a missing gh unless the user opts to continue", async () => {
    const io = fakeIo([""]); // default N on the hard stop
    const result = await runOnboarding({
      root,
      port: 4779,
      io,
      exec: fakeExec({}),
      palette: makePalette(false),
      nodeVersion: "v22.1.0",
    });
    expect(result.aborted).toBe(true);
    expect(result.config).toBeUndefined();
    expect(configExists(root)).toBe(false);
    expect(io.asked[0]).toMatch(/Continue anyway\? \[y\/N\]/);
  });

  it("continues past a missing gh when the user says yes", async () => {
    const io = fakeIo(["y", "n"]);
    const result = await runOnboarding({
      root,
      port: 4779,
      io,
      exec: fakeExec({}),
      palette: makePalette(false),
      nodeVersion: "v22.1.0",
    });
    expect(result.aborted).toBe(false);
    expect(result.config?.autoAnalyze).toBe(false);
  });

  it("warns but does not stop when only claude is missing", async () => {
    const io = fakeIo([""]);
    const result = await runOnboarding({
      root,
      port: 4779,
      io,
      exec: fakeExec({
        "gh --version": HEALTHY["gh --version"],
        "gh auth status": HEALTHY["gh auth status"],
      }),
      palette: makePalette(false),
      nodeVersion: "v22.1.0",
    });
    expect(result.aborted).toBe(false);
    expect(io.asked).toHaveLength(1);
    expect(io.output).toContain("automatic analysis and review chat are unavailable");
    expect(io.output).toContain("no claude CLI");
  });
});

/* ---------------------------------------------------- config -> trigger path */

describe("resolveAutoAnalyze", () => {
  it("defaults to true when there is no config file at all", () => {
    expect(readConfig(root).autoAnalyze).toBe(true);
    expect(resolveAutoAnalyze(readConfig(root), {})).toBe(true);
  });

  it("falls back to defaults on a corrupt config file", () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(configPath(root), "{ not json");
    expect(readConfig(root).autoAnalyze).toBe(true);
    expect(readConfig(root).devOrigins).toEqual(DEFAULT_DEV_ORIGINS);
  });

  it("honors the stored consent", () => {
    expect(resolveAutoAnalyze({ autoAnalyze: false }, {})).toBe(false);
  });

  it("lets REVIEWER_AUTO_ANALYZE=0 override a stored yes", () => {
    expect(resolveAutoAnalyze({ autoAnalyze: true }, { REVIEWER_AUTO_ANALYZE: "0" })).toBe(false);
  });

  it("accepts PURVIEW_AUTO_ANALYZE=0 as well as the legacy name", () => {
    expect(resolveAutoAnalyze({ autoAnalyze: true }, { PURVIEW_AUTO_ANALYZE: "0" })).toBe(false);
    expect(
      resolveAutoAnalyze({ autoAnalyze: true }, { PURVIEW_AUTO_ANALYZE: "1" }),
    ).toBe(true);
  });

  it("ignores other values of REVIEWER_AUTO_ANALYZE", () => {
    expect(resolveAutoAnalyze({ autoAnalyze: true }, { REVIEWER_AUTO_ANALYZE: "1" })).toBe(true);
  });
});

describe("the stored consent reaching the auto-analysis trigger", () => {
  let claude: FakeClaude;

  const ghStub: GhRunner = (args) => {
    const joined = args.join(" ");
    if (joined.includes("/compare/")) return JSON.stringify({ merge_base_commit: { sha: "mb1" } });
    if (joined.includes("v3.diff")) return REV1_PATCH;
    if (/pulls\/\d+$/.test(args[args.length - 1] ?? "")) {
      return JSON.stringify({
        node_id: "PR_1",
        number: key.number,
        title: "Add widgets",
        html_url: `https://github.com/${key.owner}/${key.repo}/pull/${key.number}`,
        state: "open",
        base: { ref: "main", sha: "base1" },
        head: { ref: "feature", sha: "head1" },
      });
    }
    return "{}";
  };

  beforeEach(() => {
    process.env.REVIEWER_SKILL_DIR = path.join(root, "skills");
    process.env.REVIEWER_CLI_PATH = path.join(root, "cli.js");
    fs.mkdirSync(process.env.REVIEWER_SKILL_DIR, { recursive: true });
    claude = fakeClaude();
    claude.install();
    setGhRunner(ghStub);
  });

  afterEach(async () => {
    await analysisIdle();
    claude.restore();
    setGhRunner(null);
    delete process.env.REVIEWER_SKILL_DIR;
    delete process.env.REVIEWER_CLI_PATH;
  });

  const addPr = async (autoAnalyze: boolean) => {
    const app = createApp({
      stateDir: root,
      webDist: path.join(root, "__no-web-dist__"),
      autoAnalyze,
      analysisTimeoutMs: 10_000,
    });
    const res = await app.request("/api/prs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: `https://github.com/${key.owner}/${key.repo}/pull/${key.number}`,
      }),
    });
    const body = await res.json();
    if (res.status !== 200) throw new Error("init failed: " + res.status + " " + JSON.stringify(body));
    return body.analysisJob;
  };

  it("spawns nothing on add when the user declined", async () => {
    writeConfig({ autoAnalyze: false }, root);
    const job = await addPr(resolveAutoAnalyze(readConfig(root), {}));
    expect(job).toBeNull();
    expect(claude.runs).toHaveLength(0);
  });

  it("queues a run on add when the user consented", async () => {
    writeConfig({ autoAnalyze: true }, root);
    const job = await addPr(resolveAutoAnalyze(readConfig(root), {}));
    expect(job.status).toBe("queued");
    expect(keyToString(key)).toBeTruthy();
    await analysisIdle();
  });
});
