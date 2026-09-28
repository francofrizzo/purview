/**
 * Above its own limit, an agent's shell tool does not show a result inline:
 * Claude Code saves it to a file and hands the model a pointer, which costs a
 * turn to discover and another to read. `show` writes big results to the PR's
 * scratch dir itself and prints the path, so the model goes straight to one
 * read. The harness running the CLI says its limit in PURVIEW_INLINE_LIMIT;
 * without one (a person at a terminal, an old server) this is Claude Code's,
 * which BASH_MAX_OUTPUT_LENGTH does not move.
 */
export const SHOW_INLINE_LIMIT = 25_000;

export const INLINE_LIMIT_ENV = "PURVIEW_INLINE_LIMIT";

export function showInlineLimit(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env[INLINE_LIMIT_ENV]);
  return Number.isInteger(n) && n > 0 ? n : SHOW_INLINE_LIMIT;
}
