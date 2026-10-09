import { describe, expect, it } from "vitest";
import type { DraftComment, RemoteComment, RemoteThread } from "../api/types";
import { lineAnchor } from "./comments";
import {
  DEFAULT_THREAD_FILTERS,
  botKey,
  drawerThreads,
  buildThreadGroups,
  cleanRemoteBody,
  excerpt,
  groupThreadsByAuthor,
  isThreadHidden,
  knownBots,
  loginListed,
  parseLoginList,
  placementLabel,
  replyTarget,
  splitReviewTags,
  threadMarker,
  threadSummary,
  threadsTitle,
  type DisplayThread,
} from "./threads";

let seq = 0;
const local = (over: Partial<DraftComment> = {}): DraftComment => ({
  id: `c${seq++}`,
  file: "src/a.ts",
  line: 3,
  side: "RIGHT",
  body: "why?",
  status: "draft",
  subjectType: "line",
  createdAt: "2026-08-10T10:00:00Z",
  ...over,
});

const rc = (over: Partial<RemoteComment> & { login?: string; bot?: boolean; botName?: string } = {}): RemoteComment => {
  const { login = "maria", bot = false, botName, ...rest } = over;
  const n = seq++;
  return {
    id: `RC_${n}`,
    databaseId: 1000 + n,
    author: { login, bot, botName },
    body: "a remote comment",
    createdAt: "2026-08-10T09:00:00Z",
    url: `https://github.com/o/r/pull/1#discussion_r${1000 + n}`,
    reviewState: "SUBMITTED",
    isMine: false,
    ...rest,
  };
};

const thread = (over: Partial<RemoteThread> = {}): RemoteThread => ({
  id: `T_${seq++}`,
  path: "src/a.ts",
  subjectType: "line",
  line: 3,
  originalLine: 3,
  startLine: null,
  side: "RIGHT",
  isResolved: false,
  isOutdated: false,
  viewerCanResolve: true,
  viewerCanUnresolve: false,
  viewerCanReply: true,
  comments: [rc()],
  ...over,
});

const A3 = lineAnchor("src/a.ts", 3, "RIGHT");

describe("buildThreadGroups", () => {
  it("keeps standalone Purview comments as one-comment threads, as before", () => {
    const a = local();
    const f = local({ subjectType: "file", line: null, side: null });
    const g = buildThreadGroups({ comments: [a, f] });
    expect(g.byLine.get(A3)!.map((t) => t.key)).toEqual([`local:${a.id}`]);
    expect(g.byFile.get("src/a.ts")!.map((t) => t.key)).toEqual([`local:${f.id}`]);
    expect(g.byLine.get(A3)![0].remote).toBeNull();
  });

  it("groups a remote thread's root and replies under its line", () => {
    const t = thread({ comments: [rc({ body: "root" }), rc({ body: "reply", login: "jkim" })] });
    const g = buildThreadGroups({ comments: [], threads: [t] });
    const [shown] = g.byLine.get(A3)!;
    expect(shown.items.map((i) => i.comment.body)).toEqual(["root", "reply"]);
    expect(shown.author).toMatchObject({ kind: "person", login: "maria", name: "@maria" });
    expect(g.located.get(t.id)).toEqual({ anchor: A3 });
  });

  it("keeps two threads on one line apart, oldest first", () => {
    const late = thread({ comments: [rc({ createdAt: "2026-08-11T00:00:00Z" })] });
    const early = thread({ comments: [rc({ createdAt: "2026-08-09T00:00:00Z" })] });
    const g = buildThreadGroups({ comments: [], threads: [late, early] });
    expect(g.byLine.get(A3)!.map((t) => t.key)).toEqual([early.id, late.id]);
  });

  it("shows a pushed Purview comment once: the local card, in the remote's slot", () => {
    const mine = local({ status: "submitted", githubCommentId: 77, githubThreadId: "T_x" });
    const t = thread({
      id: "T_x",
      comments: [rc({ databaseId: 77, isMine: true, localId: mine.id }), rc({ body: "thanks", login: "jkim" })],
    });
    const g = buildThreadGroups({ comments: [mine], threads: [t] });
    const list = g.byLine.get(A3)!;
    expect(list).toHaveLength(1);
    expect(list[0].items.map((i) => i.kind)).toEqual(["local", "remote"]);
    expect(list[0].items[0].comment.id).toBe(mine.id);
    expect(list[0].author.kind).toBe("you");
  });

  it("dedups on githubCommentId when the server did not set localId", () => {
    const mine = local({ status: "pushed", githubCommentId: 88 });
    const t = thread({ comments: [rc({ databaseId: 88, isMine: true, reviewState: "PENDING" })] });
    const g = buildThreadGroups({ comments: [mine], threads: [t] });
    expect(g.byLine.get(A3)!).toHaveLength(1);
    expect(g.byLine.get(A3)![0].items[0]).toMatchObject({ kind: "local" });
  });

  it("takes the thread a Purview comment started as its root even without an id match", () => {
    const mine = local({ status: "submitted", githubThreadId: "T_s" });
    const t = thread({ id: "T_s", comments: [rc({ isMine: true }), rc({ login: "jkim" })] });
    const g = buildThreadGroups({ comments: [mine], threads: [t] });
    expect(g.byLine.get(A3)!.map((x) => x.items.map((i) => i.kind))).toEqual([["local", "remote"]]);
  });

  it("puts local reply drafts at the end of their thread, wherever their own anchor is", () => {
    const t = thread({ line: null, isOutdated: true, originalLine: 20 });
    const reply = local({ inReplyTo: t.id, line: 20, body: "my reply" });
    const g = buildThreadGroups({ comments: [reply], threads: [t] });
    expect(g.byLine.size).toBe(0);
    const [shown] = g.byFile.get("src/a.ts")!;
    expect(shown.items.at(-1)).toMatchObject({ kind: "local", comment: { body: "my reply" } });
  });

  it("a reply whose thread is gone stands alone at its own anchor", () => {
    const reply = local({ inReplyTo: "T_gone" });
    const g = buildThreadGroups({ comments: [reply], threads: [] });
    expect(g.byLine.get(A3)!.map((t) => t.key)).toEqual([`local:${reply.id}`]);
  });

  it("a pushed reply replaces its mirror instead of appearing twice", () => {
    const t0 = thread();
    const reply = local({ inReplyTo: t0.id, status: "pushed", githubCommentId: 555 });
    const t = { ...t0, comments: [...t0.comments, rc({ databaseId: 555, isMine: true, localId: reply.id })] };
    const g = buildThreadGroups({ comments: [reply], threads: [t] });
    const items = g.byLine.get(A3)![0].items;
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ kind: "local", comment: { id: reply.id } });
  });

  it("files outdated, file-level and off-diff threads in the file's block", () => {
    const outdated = thread({ line: null, isOutdated: true, originalLine: 12 });
    const fileLevel = thread({ subjectType: "file", line: null, originalLine: null });
    const off = thread({ line: 400 });
    const on = thread({ line: 3 });
    const g = buildThreadGroups({
      comments: [],
      threads: [outdated, fileLevel, off, on],
      inDiff: (_f, line) => line < 100,
    });
    const placements = g.byFile.get("src/a.ts")!.map((t) => t.placement).sort();
    expect(placements).toEqual(["file", "off-diff", "outdated"]);
    expect(g.byLine.get(A3)!.map((t) => t.key)).toEqual([on.id]);
    expect(g.located.get(off.id)).toEqual({ file: "src/a.ts" });
  });

  it("anchors LEFT-side threads on the old side", () => {
    const t = thread({ side: "LEFT", line: 7 });
    const g = buildThreadGroups({ comments: [], threads: [t] });
    expect(g.byLine.has(lineAnchor("src/a.ts", 7, "LEFT"))).toBe(true);
  });

  describe("filters", () => {
    const resolved = thread({ isResolved: true });
    const rabbit = thread({ comments: [rc({ login: "coderabbitai[bot]", bot: true, botName: "CodeRabbit" })] });
    const copilot = thread({ comments: [rc({ login: "Copilot", bot: true, botName: "Copilot" })] });
    const human = thread();
    const all = [resolved, rabbit, copilot, human];
    const keys = (f = DEFAULT_THREAD_FILTERS) =>
      buildThreadGroups({ comments: [], threads: all, filters: f }).byLine.get(A3)?.map((t) => t.key) ?? [];

    it("shows everything by default", () => {
      expect(keys()).toHaveLength(4);
    });

    it("hides resolved threads when asked", () => {
      const g = buildThreadGroups({ comments: [], threads: all, filters: { ...DEFAULT_THREAD_FILTERS, showResolved: false } });
      expect(g.byLine.get(A3)!.map((t) => t.key)).not.toContain(resolved.id);
      expect(g.hidden).toBe(1);
    });

    it("hides every AI reviewer, or just the listed ones", () => {
      expect(keys({ ...DEFAULT_THREAD_FILTERS, showAiReviewers: false })).toEqual(
        expect.not.arrayContaining([rabbit.id, copilot.id]),
      );
      expect(keys({ ...DEFAULT_THREAD_FILTERS, hiddenBots: ["coderabbitai"] })).toEqual(
        expect.arrayContaining([copilot.id, human.id]),
      );
      expect(keys({ ...DEFAULT_THREAD_FILTERS, hiddenBots: ["coderabbitai"] })).not.toContain(rabbit.id);
    });

    it("never hides a thread holding an unsent reply", () => {
      const reply = local({ inReplyTo: resolved.id });
      const g = buildThreadGroups({
        comments: [reply],
        threads: [resolved],
        filters: { ...DEFAULT_THREAD_FILTERS, showResolved: false },
      });
      expect(g.byLine.get(A3)!.map((t) => t.key)).toEqual([resolved.id]);
    });

    it("never hides standalone Purview comments", () => {
      const t: DisplayThread = {
        key: "local:x",
        remote: null,
        items: [{ kind: "local", comment: local() }],
        resolved: false,
        placement: "line",
        author: { kind: "you", name: "you" },
      };
      expect(isThreadHidden(t, { showResolved: false, showAiReviewers: false, hiddenBots: [] })).toBe(false);
    });
  });
});

describe("threadMarker", () => {
  const groups = (comments: DraftComment[], threads: RemoteThread[]) =>
    buildThreadGroups({ comments, threads }).byLine.get(A3)!;

  it("paints the reader's status when they have comments there", () => {
    const m = threadMarker(groups([local({ status: "pushed" })], [thread()]));
    expect(m).toEqual({ count: 2, look: "pushed", resolved: false });
  });

  it("uses a neutral look for other people's threads, a bot look for bots only", () => {
    expect(threadMarker(groups([], [thread()])).look).toBe("remote");
    const bot = thread({ comments: [rc({ login: "coderabbitai[bot]", bot: true })] });
    expect(threadMarker(groups([], [bot])).look).toBe("bot");
    expect(threadMarker(groups([], [bot, thread()])).look).toBe("remote");
  });

  it("steps back when every thread is resolved", () => {
    expect(threadMarker(groups([], [thread({ isResolved: true })])).resolved).toBe(true);
    expect(threadMarker(groups([], [thread({ isResolved: true }), thread()])).resolved).toBe(false);
  });

  it("counts replies", () => {
    const t = thread({ comments: [rc(), rc(), rc()] });
    expect(threadMarker(groups([], [t])).count).toBe(3);
  });
});

describe("threadsTitle", () => {
  it("keeps the old wording for Purview-only lines", () => {
    const g = buildThreadGroups({ comments: [local()] }).byLine.get(A3)!;
    expect(threadsTitle(g)).toMatch(/^1 comment · draft/);
  });

  it("names the threads and who wrote them", () => {
    const g = buildThreadGroups({ comments: [], threads: [thread({ comments: [rc(), rc({ login: "jkim" })] })] }).byLine.get(A3)!;
    expect(threadsTitle(g)).toBe("2 comments · 1 thread by @maria — click to read them");
  });
});

describe("replyTarget", () => {
  const one = (t: RemoteThread) => buildThreadGroups({ comments: [], threads: [t] });
  it("copies the thread's line and side", () => {
    const t = thread({ side: "LEFT", line: 9 });
    const shown = one(t).byLine.get(lineAnchor("src/a.ts", 9, "LEFT"))![0];
    expect(replyTarget(shown)).toEqual({
      subjectType: "line",
      file: "src/a.ts",
      line: 9,
      side: "LEFT",
      inReplyTo: t.id,
      replyTo: "@maria",
    });
  });

  it("falls back to the original line for an outdated thread, and to the file for a file thread", () => {
    const outdated = thread({ line: null, isOutdated: true, originalLine: 20 });
    expect(replyTarget(one(outdated).byFile.get("src/a.ts")![0])).toMatchObject({ subjectType: "line", line: 20 });
    const fileLevel = thread({ subjectType: "file", line: null, originalLine: null });
    expect(replyTarget(one(fileLevel).byFile.get("src/a.ts")![0])).toMatchObject({ subjectType: "file" });
  });

  it("is null for a standalone Purview comment", () => {
    const shown = buildThreadGroups({ comments: [local()] }).byLine.get(A3)![0];
    expect(replyTarget(shown)).toBeNull();
  });
});

describe("text helpers", () => {
  const RABBIT = [
    "_⚠️ Potential issue_ | _🟠 Major_",
    "",
    "**Separator collision in the key.**",
    "",
    "Body text.",
    "",
    "```suggestion",
    "code",
    "```",
    "",
    "<details>",
    "<summary>🤖 Prompt for AI Agents</summary>",
    "",
    "do things",
    "</details>",
    "",
    "<!-- fingerprinting:phantom:poseidon:abc -->",
    "<!-- This is an auto-generated comment by CodeRabbit -->",
  ].join("\n");

  it("strips HTML comments", () => {
    expect(cleanRemoteBody(RABBIT)).not.toContain("<!--");
    expect(cleanRemoteBody("a <!-- b --> c")).toBe("a  c");
  });

  it("excerpts the content, skipping CodeRabbit's header, code and collapsibles", () => {
    expect(excerpt(RABBIT)).toBe("Separator collision in the key. Body text.");
    expect(excerpt("see [the docs](https://x) and `foo`")).toBe("see the docs and foo");
    expect(excerpt("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("splits AI reviewer tag lines, old and new CodeRabbit formats", () => {
    const fresh = "_🩺 Stability & Availability_ | _🟠 Major_ | _⚡ Quick win_\n\n<details>\n<summary>Retry storm</summary>\n\nThe loop retries forever.\n</details>";
    expect(splitReviewTags(fresh).tags).toEqual(["🩺 Stability & Availability", "🟠 Major", "⚡ Quick win"]);
    expect(splitReviewTags(fresh).body.startsWith("<details>")).toBe(true);
    expect(splitReviewTags(RABBIT).tags).toEqual(["⚠️ Potential issue", "🟠 Major"]);
    expect(splitReviewTags("_just emphasis_").tags).toEqual([]);
    expect(splitReviewTags("plain body").body).toBe("plain body");
    // nothing but a collapsible: its text is the excerpt
    expect(excerpt(fresh)).toBe("Retry storm The loop retries forever.");
  });

  it("summarizes a thread by its root", () => {
    const g = buildThreadGroups({ comments: [], threads: [thread({ comments: [rc({ body: "**Why** retry?" })] })] });
    expect(threadSummary(g.byLine.get(A3)![0])).toBe("@maria: Why retry?");
  });

  it("labels where a file-block thread came from", () => {
    const g = buildThreadGroups({
      comments: [],
      threads: [thread({ line: null, isOutdated: true, originalLine: 12 })],
    });
    expect(placementLabel(g.byFile.get("src/a.ts")![0])).toBe("outdated · was line 12");
  });

  it("normalizes bot logins", () => {
    expect(botKey("coderabbitai[bot]")).toBe("coderabbitai");
    expect(botKey("Copilot")).toBe("copilot");
  });
});

describe("groupThreadsByAuthor", () => {
  it("puts people first, then each bot by name, unresolved first", () => {
    const r1 = thread({ comments: [rc({ login: "coderabbitai[bot]", bot: true, botName: "CodeRabbit" })], isResolved: true, line: 1 });
    const r2 = thread({ comments: [rc({ login: "coderabbitai[bot]", bot: true, botName: "CodeRabbit" })], line: 5 });
    const cp = thread({ comments: [rc({ login: "Copilot", bot: true, botName: "Copilot" })] });
    const me = thread({ comments: [rc({ login: "me", isMine: true })] });
    const groups = groupThreadsByAuthor([r1, cp, r2, me]);
    expect(groups.map((g) => g.label)).toEqual(["People", "CodeRabbit", "Copilot"]);
    expect(groups[1].threads.map((t) => t.id)).toEqual([r2.id, r1.id]);
    expect(knownBots([r1, cp, r2])).toEqual([
      { key: "coderabbitai", name: "CodeRabbit", count: 2 },
      { key: "copilot", name: "Copilot", count: 1 },
    ]);
  });

  it("lists bots that only posted reviews or conversation comments, counting their posts", () => {
    const r1 = thread({ comments: [rc({ login: "coderabbitai[bot]", bot: true, botName: "CodeRabbit" })] });
    const posts = [
      { login: "coderabbitai", bot: true, botName: "CodeRabbit" },
      { login: "blacksmith-sh[bot]", bot: true },
      { login: "maria", bot: false },
    ];
    expect(knownBots([r1], posts)).toEqual([
      { key: "blacksmith-sh", name: "blacksmith-sh", count: 1 },
      { key: "coderabbitai", name: "CodeRabbit", count: 2 },
    ]);
  });
});

describe("loginListed", () => {
  it("matches case-insensitively and ignores a [bot] suffix on either side", () => {
    const list = ["Primitos[bot]", "my-agent"];
    expect(loginListed("primitos", list)).toBe(true);
    expect(loginListed("primitos[bot]", list)).toBe(true);
    expect(loginListed("MY-AGENT[bot]", list)).toBe(true);
    expect(loginListed("primitos-2", list)).toBe(false);
    expect(loginListed(undefined, list)).toBe(false);
    expect(loginListed("primitos", [])).toBe(false);
  });
});

describe("parseLoginList", () => {
  it("splits on commas and spaces, drops @ and case-insensitive duplicates", () => {
    expect(parseLoginList(" coderabbitai, @Sweep-AI  sweep-ai,,\nbot2 ")).toEqual(["coderabbitai", "Sweep-AI", "bot2"]);
    expect(parseLoginList("  ")).toEqual([]);
  });
});

describe("drawerThreads", () => {
  it("drops threads Purview started that nobody answered", () => {
    const lone = thread({ comments: [rc({ isMine: true, localId: "c1" })] });
    const answered = thread({ comments: [rc({ isMine: true, localId: "c2" }), rc({ login: "dana" })] });
    const theirs = thread();
    expect(drawerThreads([lone, answered, theirs]).map((t) => t.id)).toEqual([answered.id, theirs.id]);
  });
});

describe("multi-line threads", () => {
  it("hangs a range thread off its last line only when both ends are in the diff", () => {
    const t = thread({ line: 9, startLine: 7, originalLine: 9, originalStartLine: 7, startSide: "RIGHT" });
    const inDiff = (_f: string, line: number) => line >= 8;
    const g = buildThreadGroups({ comments: [], threads: [t], inDiff });
    expect(g.byLine.size).toBe(0);
    expect(g.byFile.get("src/a.ts")?.[0].placement).toBe("off-diff");
    expect(placementLabel(g.byFile.get("src/a.ts")![0])).toBe("lines 7–9 · not in this diff");
    const ok = buildThreadGroups({ comments: [], threads: [t], inDiff: () => true });
    expect(ok.byLine.get(lineAnchor("src/a.ts", 9, "RIGHT"))).toHaveLength(1);
  });

  it("says what lines an outdated range was on", () => {
    const t = thread({ line: null, startLine: null, originalLine: 9, originalStartLine: 7, isOutdated: true });
    const g = buildThreadGroups({ comments: [], threads: [t] });
    expect(placementLabel(g.byFile.get("src/a.ts")![0])).toBe("outdated · was lines 7–9");
  });

  it("reports the lines a thread covers, remote or local", async () => {
    const { threadRange } = await import("./threads");
    const remote = thread({ line: 9, startLine: 7 });
    const g = buildThreadGroups({
      comments: [local({ id: "r", line: 20, startLine: 18 }), local({ id: "s", line: 21 })],
      threads: [remote],
    });
    const by = (key: string) => [...g.byLine.values()].flat().find((t) => t.key === key)!;
    expect(threadRange(by(remote.id))).toEqual({ path: "src/a.ts", side: "RIGHT", start: 7, end: 9 });
    expect(threadRange(by("local:r"))).toEqual({ path: "src/a.ts", side: "RIGHT", start: 18, end: 20 });
    expect(threadRange(by("local:s"))).toBeNull();
    expect(threadRange(by(thread({ line: 9, startLine: null }).id) ?? by(remote.id))).not.toBeNull();
  });
});
