/** POSIX single-quoting: safe for any byte string, including `'` itself. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Bare when it is plainly safe (a session UUID always is), quoted otherwise. */
function shellWord(s: string): string {
  return /^[A-Za-z0-9._-]+$/.test(s) ? s : shellQuote(s);
}

/**
 * The one-liner that forks a Purview chat session into the reader's own
 * terminal: `--resume` only finds the session from the cwd it was filed
 * under, `--fork-session` leaves Purview's copy untouched, and the context
 * file is sent as the fork's first message.
 *
 * Not `--append-system-prompt`: a resumed session — forked or not, headless
 * or interactive — keeps the system prompt it was created with and silently
 * ignores a new one (checked on 2.1.283), so the fork would carry on under
 * the panel's read-only rules with none of the terminal context. The prompt
 * goes before `--add-dir`, whose variadic value would swallow it.
 */
export function handoffCommand(input: {
  cwd: string;
  sessionId: string;
  contextPath: string;
  /** extra readable roots (PR state, skill docs) the context file points at */
  addDirs?: string[];
}): string {
  const dirs = (input.addDirs ?? []).map((d) => ` --add-dir ${shellQuote(d)}`).join("");
  return (
    `cd ${shellQuote(input.cwd)} && claude --resume ${shellWord(input.sessionId)} --fork-session ` +
    `"$(cat ${shellQuote(input.contextPath)})"${dirs}`
  );
}
