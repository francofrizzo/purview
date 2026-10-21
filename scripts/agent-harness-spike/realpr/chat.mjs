// chat.mjs <port> <repo> <pr> <arm> [question] [draft-request]
import { checkKey, client, selection, verify, preflight, post, checkPort } from "./protocol.mjs";
try {
  const [port, repo, n, arm, q = "What does this PR change? Cite file and line.", draft = "Leave a draft comment for the author on the main change, audience github."] = process.argv.slice(2);
  checkKey(repo, [n]);
  const expected = selection(arm), j = client(port), p = `/prs/${encodeURIComponent(`${repo}/${n}`)}`;
  await preflight(j, repo, expected);
  async function turn(text, stop = false) {
    const before = await j(`${p}/chat`);
    verify(before.agent, expected);
    if (before.busy) throw Error("chat busy");
    const t = Date.now();
    const res = await fetch(`http://127.0.0.1:${checkPort(port)}/api${p}/chat`, { ...post({ text, refs: [] }), signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw Error("chat failed");
    let timer, stopping, stopped = false, bytes = 0;
    try {
      if (stop) timer = setTimeout(() => {
        stopping = j(`${p}/chat/stop`, post({})).then(r => { stopped = r.ok === true; }, () => { stopped = false; });
      }, 4000);
      for await (const chunk of res.body) bytes += chunk.length;
    } finally { clearTimeout(timer); if (stopping) await stopping; }
    const after = await j(`${p}/chat`);
    verify(after.agent, expected);
    if (after.busy || after.sessionHarness !== expected.harness || after.messages.length <= before.messages.length || (!stop && (after.messages.at(-1)?.role !== "assistant" || !after.messages.at(-1)?.text?.length || after.messages.at(-1)?.interrupted)) || (stop && (!stopped || !after.messages.at(-1)?.interrupted))) throw Error("chat result failed");
    console.log(JSON.stringify({ stage: stop ? "stop" : "turn", harness: expected.harness, model: expected.model, busy: after.busy, messages: after.messages.length, streamBytes: bytes, stopped, wallMs: Date.now() - t }));
  }
  const before = (await j(`${p}/comments`)).comments ?? [];
  await turn(q);
  await turn(draft);
  const after = (await j(`${p}/comments`)).comments ?? [];
  const added = after.filter(c => !before.some(b => b.id === c.id));
  console.log(JSON.stringify({ draftsAdded: added.length }));
  if (!added.length || added.some(c => c.status !== "draft" || c.audience !== "github")) throw Error("draft result failed");
  await turn("Walk through every file of the PR exhaustively and summarize each one.", true);
  await turn("Continue after the stopped turn. Give a brief summary.");
} catch { console.error("chat comparison failed (details withheld); inspect private state locally"); process.exitCode = 1; }
