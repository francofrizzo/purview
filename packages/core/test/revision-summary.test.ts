import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keyToString, type PrKey } from "../src/paths.js";
import { appendEvent, loadState, readEvents, writeMeta, writeRevision } from "../src/store.js";
import { applyEvent, fold, withoutDiscarded } from "../src/reducer.js";
import { setRevisionSummary } from "../src/service.js";
import { formatReport } from "../src/report.js";
import { renderChanges } from "../src/changes.js";
import { EventSchema, REVISION_SUMMARY_MAX } from "../src/schemas.js";
import type { ReviewerEvent } from "../src/schemas.js";

/**
 * The per-revision summary: the `revision-summarized` event, its reducer
 * rule, `setRevisionSummary`'s validation, and the `set-revision-summary`
 * CLI subcommand (against the built CLI in a temp state root).
 */

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const key: PrKey = { host: "github.com", owner: "acme", repo: "widgets", number: 11 };
const K = keyToString(key);
const ts = "2026-01-01T00:00:00.000Z";

const revAdded = (revision: number): ReviewerEvent => ({
  ts,
  type: "revision-added",
  revision,
  baseSha: `base${revision}`,
  headSha: `head${revision}`,
  mergeBase: `mb${revision}`,
  baseOnly: false,
  files: [],
});

const base: ReviewerEvent[] = [
  {
    ts,
    type: "pr-initialized",
    host: key.host,
    owner: key.owner,
    repo: key.repo,
    number: key.number,
    url: "https://github.com/acme/widgets/pull/11",
    title: "Add widgets",
  },
  revAdded(1),
  revAdded(2),
];

describe("revision-summarized event", () => {
  it("parses, and stores the text on the matching revision; the newest one wins", () => {
    const ev = { ts, type: "revision-summarized", revision: 2, text: "moved the timeout to shared.go" };
    expect(EventSchema.safeParse(ev).success).toBe(true);
    expect(EventSchema.safeParse({ ...ev, text: "" }).success).toBe(false);
    expect(EventSchema.safeParse({ ...ev, text: "x".repeat(REVISION_SUMMARY_MAX + 1) }).success).toBe(false);

    const s = fold([...base, ev as ReviewerEvent]);
    expect(s.revisions.map((r) => r.summary)).toEqual([undefined, "moved the timeout to shared.go"]);
    const again = applyEvent(s, { ...(ev as ReviewerEvent), text: "second thoughts" } as ReviewerEvent);
    expect(again.revisions[1].summary).toBe("second thoughts");
    // The reducer's existing output is untouched: a log without the event folds as before.
    expect(fold(base).revisions.every((r) => r.summary === undefined)).toBe(true);
  });

  it("drops a summary for a revision the log never added, and goes with a discarded revision", () => {
    const s = fold([...base, { ts, type: "revision-summarized", revision: 5, text: "ghost" }]);
    expect(s.revisions.every((r) => r.summary === undefined)).toBe(true);

    const log: ReviewerEvent[] = [
      ...base,
      { ts, type: "revision-summarized", revision: 2, text: "gone with r2" },
      { ts, type: "revision-discarded", revision: 2 },
    ];
    expect(withoutDiscarded(log).some((e) => e.type === "revision-summarized")).toBe(false);
    expect(fold(log).revisions).toHaveLength(1);
  });

  it("is printed by report, and changes names the gap for the current revision only", () => {
    const s = fold([...base, revAdded(3), { ts, type: "revision-summarized", revision: 2, text: "r2 note" }]);
    const report = formatReport(s);
    expect(report).toContain("Revisions\n  r2  r2 note\n  r3  (no summary yet)\n");
    expect(fold(base.slice(0, 2)) && formatReport(fold(base.slice(0, 2)))).not.toContain("Revisions");

    const gap = "Revision 3 has no summary yet";
    expect(renderChanges({ state: s, report: undefined, revision: 3 }).body).toContain(gap);
    expect(renderChanges({ state: s, report: undefined, revision: 2 }).body).not.toContain("has no summary");
    expect(renderChanges({ state: s, report: undefined, revision: 1 }).body).not.toContain("has no summary");
    // A caller without `revisions` (a partial state) gets no note.
    const { revisions: _r, ...partial } = s;
    expect(renderChanges({ state: partial, report: undefined, revision: 3 }).body).not.toContain("has no summary");
  });
});

/* ------------------------------------------------------- service and CLI */

let tmp: string;

function seed(revisions = 2): void {
  writeMeta(key, {
    host: key.host,
    owner: key.owner,
    repo: key.repo,
    number: key.number,
    url: "https://github.com/acme/widgets/pull/11",
    title: "Add widgets",
    createdAt: ts,
  });
  const { ts: _ts0, ...init } = base[0];
  appendEvent(key, init);
  for (let n = 1; n <= revisions; n++) {
    writeRevision(key, n, "diff", [], { baseSha: `base${n}`, headSha: `head${n}`, mergeBase: `mb${n}` });
    const { ts: _ts, ...ev } = revAdded(n);
    appendEvent(key, ev);
  }
}

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [cliPath, ...args], {
      encoding: "utf8",
      env: { ...process.env, REVIEWER_STATE_DIR: tmp },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status, stdout: e.stdout, stderr: e.stderr };
  }
}

beforeAll(() => {
  expect(fs.existsSync(cliPath), "dist/cli.js missing — run `pnpm -r build` first").toBe(true);
});
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "purview-revsum-test-"));
  process.env.REVIEWER_STATE_DIR = tmp;
});
afterAll(() => {
  delete process.env.REVIEWER_STATE_DIR;
});

describe("setRevisionSummary", () => {
  it("records the current revision's summary, trimmed, and replaces it on a second call", () => {
    seed();
    const first = setRevisionSummary(key, "  timeout moved to shared.go  ");
    expect(first.revision).toBe(2);
    expect(first.text).toBe("timeout moved to shared.go");
    expect(first.state.revisions[1].summary).toBe("timeout moved to shared.go");
    const second = setRevisionSummary(key, "and the queue failure model", 2);
    expect(second.state.revisions[1].summary).toBe("and the queue failure model");
    expect(readEvents(key).filter((e) => e.type === "revision-summarized")).toHaveLength(2);
  });

  it("refuses an empty text, revision 1 and an unknown revision, writing nothing", () => {
    seed();
    const before = readEvents(key).length;
    expect(() => setRevisionSummary(key, "   ")).toThrow(/non-empty/);
    expect(() => setRevisionSummary(key, 42 as unknown as string)).toThrow(/non-empty/);
    expect(() => setRevisionSummary(key, "nope", 1)).toThrow(/Revision 1 takes no summary/);
    expect(() => setRevisionSummary(key, "nope", 7)).toThrow(/No revision 7 on this PR \(it has r1, r2\)/);
    expect(readEvents(key).length).toBe(before);
    expect(loadState(key).revisions.every((r) => r.summary === undefined)).toBe(true);
  });

  it("clips an over-long summary at a word with a warning", () => {
    seed();
    const long = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ");
    const res = setRevisionSummary(key, long);
    expect(res.text.length).toBeLessThanOrEqual(REVISION_SUMMARY_MAX);
    expect(res.text.endsWith("…")).toBe(true);
    expect(res.warnings).toEqual([`warning: revision 2 summary truncated (${long.length}->${REVISION_SUMMARY_MAX} chars)`]);
  });
});

describe("cli set-revision-summary", () => {
  it("writes the summary from --text or --file and prints it", () => {
    seed(3);
    const r = run(["set-revision-summary", K, "--text", "stop timeout constant moved to shared.go", "--rev", "2"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("Revision 2 summary saved: stop timeout constant moved to shared.go\n");
    const file = path.join(tmp, "summary.json");
    fs.writeFileSync(file, JSON.stringify({ text: "queue mapping failure model moved to models/communication.go" }));
    const r3 = run(["set-revision-summary", K, "--file", file]);
    expect(r3.status).toBe(0);
    expect(r3.stdout).toContain("Revision 3 summary saved: queue mapping");
    expect(loadState(key).revisions.map((x) => x.summary)).toEqual([
      undefined,
      "stop timeout constant moved to shared.go",
      "queue mapping failure model moved to models/communication.go",
    ]);
    expect(run(["report", K]).stdout).toContain("  r2  stop timeout constant moved to shared.go\n  r3  queue mapping");
  });

  it("exits 1 without --text/--file, with both, for revision 1, and for an empty text", () => {
    seed();
    for (const args of [
      [],
      ["--text", "a", "--file", "b.json"],
      ["--text", "a", "--rev", "1"],
      ["--text", ""],
    ]) {
      const r = run(["set-revision-summary", K, ...args]);
      expect(r.status, args.join(" ")).toBe(1);
    }
    expect(run(["set-revision-summary", K, "--text", "a", "--rev", "1"]).stderr).toContain("Revision 1 takes no summary");
    expect(readEvents(key).some((e) => e.type === "revision-summarized")).toBe(false);
  });
});
