/** POSIX single-quoting: safe for any byte string, including `'` itself. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Start ordinary Claude Code in a writable coding worktree. Never resume
 * the review session: it retains the panel's read-only system instructions.
 * The prompt precedes --add-dir, whose variadic value would swallow it.
 */
export function handoffCommand(input: {
  cwd: string;
  contextPath: string;
  /** extra readable roots (PR state, skill docs) the context file points at */
  addDirs?: string[];
}): string {
  const dirs = (input.addDirs ?? []).map((d) => ` --add-dir ${shellQuote(d)}`).join("");
  return (
    `cd ${shellQuote(input.cwd)} && claude ` +
    `"$(cat ${shellQuote(input.contextPath)})"${dirs}`
  );
}
