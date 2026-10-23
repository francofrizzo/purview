export async function runNotesCommand(args: string[], options: {
  port: number; fetch?: typeof fetch; print?: (line: string) => void; sleep?: (ms: number) => Promise<void>;
}): Promise<number> {
  const print = options.print ?? ((text: string) => process.stdout.write(text + "\n"));
  const usage = "Usage: purview notes <pr> [--wait] [--agent <name>] [--peek]";
  if (args.includes("--help")) { print(usage); return 0; }
  let pr: string | undefined;
  let wait = false;
  let peek = false;
  let agent = process.env.PURVIEW_AGENT || (process.env.CLAUDECODE ? "Claude Code" : process.env.CODEX_SANDBOX || process.env.CODEX_HOME ? "Codex" : "coding agent");
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--wait") wait = true;
    else if (arg === "--peek") peek = true;
    else if (arg === "--agent" && args[i + 1]?.trim() && !args[i + 1].startsWith("--")) agent = args[++i];
    else if (!arg.startsWith("--") && !pr) pr = arg;
    else { print(usage); return 1; }
  }
  if (!pr) { print(usage); return 1; }
  const url = `http://localhost:${options.port}/api/prs/${encodeURIComponent(pr)}/agent-notes`;
  const request = options.fetch ?? fetch;
  try {
    for (;;) {
      const res = await request(peek ? url : `${url}/pickup`, peek ? {} : {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent, wait: wait ? 30 : 0 }),
      });
      if (res.status === 404) { print(`PR is not tracked in Purview: ${pr}`); return 1; }
      if (!res.ok) { print(`Purview returned ${res.status}: ${await res.text()}`); return 1; }
      const result = await res.json() as { markdown: string; notes?: unknown[]; pending?: unknown[] };
      if ((result.notes ?? result.pending ?? []).length) { print(result.markdown); return 0; }
      if (peek || !wait) { print("No new notes for the agent."); return 0; }
      await (options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(100);
    }
  } catch (error) {
    const refused = (e: unknown): boolean => typeof e === "object" && e !== null && (
      (e as { code?: string }).code === "ECONNREFUSED" ||
      refused((e as { cause?: unknown }).cause) ||
      ((e as { errors?: unknown[] }).errors ?? []).some(refused));
    print(refused(error) ? `Purview is not running on port ${options.port}.` : `Could not read Purview notes: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
