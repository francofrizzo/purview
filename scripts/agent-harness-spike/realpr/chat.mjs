// chat.mjs <port> <host/owner/repo> <pr> <question> <draft-request> — one exploration question, one draft request, one Stop; prints sanitized outcomes (lengths, anchors, timings; the first 400 chars of each answer).
const [port, repo, n, Q1 = "What does this PR change, and where? Cite file and line.", Q2 = "Leave a draft comment for the author on the main change, audience github."] = process.argv.slice(2);
const key = encodeURIComponent(`${repo}/${n}`); const P = `http://127.0.0.1:${port}/api`;
const j = async (p, init) => { const r = await fetch(P + p, init); if (!r.ok) throw new Error(`${p}: ${r.status} ${await r.text()}`); return r.json(); };
async function turn(text, { stopAfterMs } = {}) {
  const t0 = Date.now();
  const res = await fetch(`${P}/prs/${key}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, refs: [] }) });
  if (!res.ok) throw new Error(`chat: ${res.status} ${await res.text()}`);
  let stopped = null;
  if (stopAfterMs) setTimeout(async () => { try { stopped = await j(`/prs/${key}/chat/stop`, { method: "POST" }); } catch (e) { stopped = { error: String(e) }; } }, stopAfterMs);
  const reader = res.body.getReader(); let bytes = 0; for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; }
  const chat = await j(`/prs/${key}/chat`);
  const last = chat.messages.at(-1);
  return { wallS: Math.round((Date.now() - t0) / 1000), streamBytes: bytes, busy: chat.busy, harness: chat.sessionHarness, messages: chat.messages.length,
    lastRole: last?.role, lastChars: (last?.text ?? last?.content ?? "").length, lastHead: (last?.text ?? last?.content ?? "").slice(0, 400).replace(/\n+/g, " / "), stopped };
}
const before = (await j(`/prs/${key}/comments`)).comments?.length ?? 0;
console.log("Q1", JSON.stringify(await turn(Q1)));
console.log("Q2", JSON.stringify(await turn(Q2)));
const comments = (await j(`/prs/${key}/comments`)).comments ?? [];
console.log("drafts", JSON.stringify({ before, after: comments.length, last: comments.at(-1) && { path: comments.at(-1).path, line: comments.at(-1).line ?? comments.at(-1).anchor?.line, status: comments.at(-1).status, audience: comments.at(-1).audience, chars: (comments.at(-1).body || "").length } }));
console.log("Q3-stop", JSON.stringify(await turn("Walk through every file of the PR exhaustively and summarize each one.", { stopAfterMs: 4000 })));
