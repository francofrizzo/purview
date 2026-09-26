import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/**
 * Child-process supervision shared by every CLI harness: prompt over stdin,
 * stdout split into lines, a bounded stderr tail, timeout, SIGTERM then
 * SIGKILL, cancellation, and exactly one terminal `exit` event. Nothing here
 * knows what the lines mean — the adapter translates them.
 */

export interface ChildProcessLike {
  stdout: Readable | null;
  stderr: Readable | null;
  stdin: Writable | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

export type ProcessSpawner = (
  command: string,
  argv: string[],
  opts: { cwd: string; env?: Record<string, string> },
) => ChildProcessLike;

export const spawnProcess: ProcessSpawner = (command, argv, opts) =>
  spawn(command, argv, {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    // Never secrets: harnesses reuse the user's own auth. `opts.env` only adds
    // non-secret markers (e.g. the chat's PURVIEW_ACTOR).
    env: { ...process.env, ...opts.env },
  }) as unknown as ChildProcessLike;

export type ProcessExit =
  | { reason: "exited"; code: number | null; stderrTail: string }
  | { reason: "cancelled" }
  | { reason: "timeout"; timeoutMs: number }
  /** the spawn threw, or the child emitted `error` */
  | { reason: "error"; message: string; spawnFailed: boolean };

export type ProcessEvent = { type: "line"; line: string } | { type: "exit"; exit: ProcessExit };

export interface SupervisedProcess {
  events: AsyncIterable<ProcessEvent>;
  /** SIGTERM now; the stream still ends with `exit` (reason "cancelled"). */
  cancel(): void;
}

const KILL_GRACE_MS = 5_000;

export function superviseProcess(opts: {
  spawn: ProcessSpawner;
  command: string;
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  /** written to stdin and closed — keeps large or sensitive input out of argv */
  stdin: string;
  timeoutMs: number;
}): SupervisedProcess {
  const queue: ProcessEvent[] = [];
  let resolveNext: (() => void) | null = null;
  let finished = false;

  const push = (event: ProcessEvent) => {
    if (finished) return;
    if (event.type === "exit") finished = true;
    queue.push(event);
    resolveNext?.();
    resolveNext = null;
  };

  const events = (async function* (): AsyncGenerator<ProcessEvent> {
    for (;;) {
      if (queue.length === 0) {
        if (finished) return;
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
        continue;
      }
      const next = queue.shift()!;
      yield next;
      if (next.type === "exit") return;
    }
  })();

  let child: ChildProcessLike;
  try {
    child = opts.spawn(
      opts.command,
      opts.argv,
      opts.env ? { cwd: opts.cwd, env: opts.env } : { cwd: opts.cwd },
    );
  } catch (err) {
    push({ type: "exit", exit: { reason: "error", message: (err as Error).message, spawnFailed: true } });
    return { events, cancel: () => {} };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, opts.timeoutMs);

  let killTimer: NodeJS.Timeout | undefined;
  function terminate() {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    // A wedged child must not hold its slot forever.
    killTimer ??= setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, KILL_GRACE_MS);
    killTimer.unref?.();
  }

  let cancelled = false;
  const stderrChunks: string[] = [];
  child.stderr?.on("data", (d: Buffer) => {
    stderrChunks.push(d.toString());
    if (stderrChunks.length > 200) stderrChunks.shift();
  });

  let buffer = "";
  child.stdout?.on("data", (d: Buffer) => {
    buffer += d.toString();
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      push({ type: "line", line });
    }
  });

  child.on("error", (err: Error) => {
    clearTimeout(timer);
    push({ type: "exit", exit: { reason: "error", message: err.message, spawnFailed: false } });
  });

  child.on("exit", (code: number | null) => {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    if (buffer.trim()) push({ type: "line", line: buffer });
    buffer = "";
    if (cancelled) push({ type: "exit", exit: { reason: "cancelled" } });
    else if (timedOut) push({ type: "exit", exit: { reason: "timeout", timeoutMs: opts.timeoutMs } });
    else {
      push({
        type: "exit",
        exit: { reason: "exited", code, stderrTail: stderrChunks.join("").trim().slice(-2000) },
      });
    }
  });

  try {
    child.stdin?.end(opts.stdin);
  } catch {
    /* the exit/error handler reports it */
  }

  return {
    events,
    cancel: () => {
      cancelled = true;
      terminate();
    },
  };
}
