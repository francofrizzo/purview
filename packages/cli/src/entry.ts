import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSkillCommand } from "../../server/src/skill-command.js";
import { DEFAULT_PORT } from "../../server/src/app.js";
import { main } from "../../server/src/main.js";

/**
 * Bundled entry point for the published `@francofrizzo/purview` package.
 * esbuild inlines this straight from TypeScript source (see
 * scripts/build.mjs) into a single `dist/server.js`, alongside a copy of
 * `packages/web/dist` at `../web-dist`. `createApp`'s own `webDist` fallback
 * guesses `../../web/dist` relative to its own file, which only holds inside
 * the monorepo — once bundled and shipped without the monorepo around it,
 * that guess resolves to nothing, so this entry computes the real,
 * packaged location itself from its own `import.meta.url` and passes it
 * through explicitly.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.join(here, "..", "web-dist");

if (process.argv[2] === "skill") {
  try {
    process.exitCode = runSkillCommand(process.argv.slice(3), {
      port: Number(process.env.PURVIEW_PORT ?? DEFAULT_PORT),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
} else {
  void main({ webDist });
}
