/**
 * Stand-in for the `claude` CLI: emits canned stream-json lines, then exits (or
 * hangs until SIGTERM, for cancellation/timeout tests). Driven entirely by env
 * vars so one script covers every scenario.
 *
 *   FAKE_CLAUDE_LINES        JSON array of objects to print, one per line
 *   FAKE_CLAUDE_EXIT         exit code (default 0)
 *   FAKE_CLAUDE_HANG         if set, never exit on its own
 *   FAKE_CLAUDE_PROMPT_FILE  where to dump the prompt read from stdin
 *   FAKE_CLAUDE_ARGV_FILE    where to dump argv (one JSON array per run, appended)
 *   FAKE_CLAUDE_STDERR       text to write on stderr
 */
import fs from "node:fs";

const lines = JSON.parse(process.env.FAKE_CLAUDE_LINES ?? "[]");

if (process.env.FAKE_CLAUDE_ARGV_FILE) {
  fs.appendFileSync(
    process.env.FAKE_CLAUDE_ARGV_FILE,
    JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\n",
  );
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
if (process.env.FAKE_CLAUDE_PROMPT_FILE) {
  fs.writeFileSync(process.env.FAKE_CLAUDE_PROMPT_FILE, Buffer.concat(chunks).toString());
}

// writeSync so nothing is lost to an unflushed stream on exit.
for (const line of lines) fs.writeSync(1, JSON.stringify(line) + "\n");
if (process.env.FAKE_CLAUDE_STDERR) fs.writeSync(2, process.env.FAKE_CLAUDE_STDERR);

if (process.env.FAKE_CLAUDE_HANG) {
  setInterval(() => {}, 1000);
} else {
  process.exit(Number(process.env.FAKE_CLAUDE_EXIT ?? 0));
}
