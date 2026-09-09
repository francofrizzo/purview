import { serve } from "@hono/node-server";
import { migrateStateDirOnStartup, stateRoot } from "@reviewer/core";
import { createApp, DEFAULT_PORT } from "./app.js";
import { autoAnalyzeEnvAllows, readConfig } from "./config.js";
import { maybeOnboard } from "./onboarding.js";
import { startReviewWatch } from "./review-watch.js";

/**
 * Shared entry point, called both by the dev entry (`index.ts`, which serves
 * `../../web/dist` via app.ts's own fallback) and by the packaged CLI's
 * bundled entry, which passes `webDist` explicitly because the fallback's
 * `import.meta.url`-relative guess doesn't hold once this module is bundled
 * into `packages/cli/dist/server.js` and shipped without the monorepo around
 * it.
 */
export interface MainOptions {
  webDist?: string;
}

export async function main(opts: MainOptions = {}): Promise<void> {
  // The state directory was renamed `~/.reviewer` -> `~/.purview`. Do the
  // one-time move before anything reads or writes state.
  migrateStateDirOnStartup();
  const ROOT = stateRoot();
  const PORT = Number(process.env.PURVIEW_PORT ?? process.env.REVIEWER_PORT ?? DEFAULT_PORT);

  // First run on a terminal: check the environment and ask for cost consent
  // before anything can spend money. Skipped silently when config.json already
  // exists or stdout is not a TTY; `--onboard` forces a re-run.
  const force = process.argv.includes("--onboard");
  const onboarding = await maybeOnboard({ root: ROOT, port: PORT, force });
  if (onboarding?.aborted) process.exit(1);

  const config = onboarding?.config ?? readConfig(ROOT);

  const app = createApp({
    // The master switch is the env kill switch only: consent itself is
    // layered (repo.json -> committed .purview/config.json -> global
    // config.json), and is resolved per PR inside the app.
    autoAnalyze: autoAnalyzeEnvAllows(),
    port: PORT,
    devOrigins: config.devOrigins,
    webDist: opts.webDist,
  });

  // Loopback only. Binding 0.0.0.0 would put an unauthenticated API that can
  // spend money and write to GitHub on every interface the machine has.
  const server = serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, (info) => {
    console.log(`@reviewer/server listening on http://localhost:${info.port}`);
  });

  // @hono/node-server's serve() hands back the underlying node:http server,
  // whose listen() reports bind failures asynchronously via "error" rather
  // than throwing — left unhandled, EADDRINUSE crashes with a raw stack that
  // gives no hint that it's just "something else is already on this port".
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `Port ${PORT} is already in use — another Purview server is probably running.\n` +
          `Set PURVIEW_PORT to run this one on a different port.`,
      );
      process.exit(1);
    }
    throw err;
  });

  // The watcher always starts (each repo's own `watchReviews` opt-in still
  // gates whether it does anything); only whether an imported PR triggers an
  // analysis is decided by the env switch, read fresh on every tick so
  // flipping it takes effect without a restart. `PURVIEW_NO_WATCH` (see
  // review-watch.ts) disables polling entirely, e.g. for tests or a
  // guaranteed-no-background-gh-calls run.
  startReviewWatch(ROOT, { analyzeAllowed: autoAnalyzeEnvAllows });
}
