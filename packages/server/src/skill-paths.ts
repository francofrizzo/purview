import path from "node:path";

/**
 * Where the skill and the `reviewer-state` CLI live. Split out of analysis.ts
 * so every prompt builder can resolve them without importing the analysis
 * runner (which imports the prompt builders in turn).
 */

/** Repo root: `<root>/packages/server/{src,dist}/skill-paths.{ts,js}` -> `<root>`. */
function repoRoot(): string {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
}

export function skillDir(): string {
  return process.env.PURVIEW_SKILL_DIR ?? process.env.REVIEWER_SKILL_DIR ??
    path.join(repoRoot(), "skills", "pr-review");
}

/**
 * The `reviewer-state` bin is usually not on PATH, so runs invoke the built
 * CLI by absolute path through node. That absolute string is also what the
 * Bash allowlist pattern is built from, which is why it must be resolved once
 * here rather than assembled per call site.
 */
export function cliPath(): string {
  return (
    process.env.PURVIEW_CLI_PATH ??
    process.env.REVIEWER_CLI_PATH ??
    path.join(repoRoot(), "packages", "core", "dist", "cli.js")
  );
}

export function cliCommand(): string {
  return `${process.execPath} ${cliPath()}`;
}
