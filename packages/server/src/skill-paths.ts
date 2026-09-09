import fs from "node:fs";
import path from "node:path";

/**
 * Where the skill and the `reviewer-state` CLI live. Split out of analysis.ts
 * so every prompt builder can resolve them without importing the analysis
 * runner (which imports the prompt builders in turn).
 *
 * Two layouts have to resolve from the same `import.meta.url`-relative logic:
 *  - dev / from-source: this module lives at
 *    `<repo>/packages/server/{src,dist}/skill-paths.{ts,js}`, and the skill +
 *    CLI live in the monorepo at `<repo>/skills/pr-review` and
 *    `<repo>/packages/core/dist/cli.js`.
 *  - packaged (`@francofrizzo/purview`, npm): esbuild bundles this module
 *    into a single `packages/cli/dist/server.js`, shipped with no monorepo
 *    around it, so the repo-relative guess above resolves to nothing. The
 *    package's build step copies the skill to `dist/skill` and bundles the
 *    core CLI to `dist/reviewer-state.js`, both next to the bundle itself —
 *    checked first, falling back to the dev layout so nothing here needs to
 *    know which mode it's running in.
 */

function moduleDir(): string {
  return path.dirname(new URL(import.meta.url).pathname);
}

/** Repo root: `<root>/packages/server/{src,dist}/skill-paths.{ts,js}` -> `<root>`. */
function repoRoot(): string {
  return path.resolve(moduleDir(), "../../..");
}

function devSkillDir(): string {
  return path.join(repoRoot(), "skills", "pr-review");
}

function devCliPath(): string {
  return path.join(repoRoot(), "packages", "core", "dist", "cli.js");
}

function packagedSkillDir(): string {
  return path.join(moduleDir(), "skill");
}

function packagedCliPath(): string {
  return path.join(moduleDir(), "reviewer-state.js");
}

export function skillDir(): string {
  const override = process.env.PURVIEW_SKILL_DIR ?? process.env.REVIEWER_SKILL_DIR;
  if (override) return override;
  const packaged = packagedSkillDir();
  return fs.existsSync(packaged) ? packaged : devSkillDir();
}

/**
 * The `reviewer-state` bin is usually not on PATH, so runs invoke the built
 * CLI by absolute path through node. That absolute string is also what the
 * Bash allowlist pattern is built from, which is why it must be resolved once
 * here rather than assembled per call site.
 */
export function cliPath(): string {
  const override = process.env.PURVIEW_CLI_PATH ?? process.env.REVIEWER_CLI_PATH;
  if (override) return override;
  const packaged = packagedCliPath();
  return fs.existsSync(packaged) ? packaged : devCliPath();
}

export function cliCommand(): string {
  return `${process.execPath} ${cliPath()}`;
}
