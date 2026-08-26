import { serve } from "@hono/node-server";
import { stateRoot } from "@reviewer/core";
import { createApp, DEFAULT_PORT } from "./app.js";
import { readConfig, resolveAutoAnalyze } from "./config.js";
import { maybeOnboard } from "./onboarding.js";

const PORT = Number(process.env.REVIEWER_PORT ?? DEFAULT_PORT);
const ROOT = stateRoot();

async function main(): Promise<void> {
  // First run on a terminal: check the environment and ask for cost consent
  // before anything can spend money. Skipped silently when config.json already
  // exists or stdout is not a TTY; `--onboard` forces a re-run.
  const force = process.argv.includes("--onboard");
  const onboarding = await maybeOnboard({ root: ROOT, port: PORT, force });
  if (onboarding?.aborted) process.exit(1);

  const config = onboarding?.config ?? readConfig(ROOT);

  const app = createApp({
    // Consent from config.json decides whether adding/refreshing a PR spawns
    // Claude. REVIEWER_AUTO_ANALYZE=0 still overrides it for a single run.
    autoAnalyze: resolveAutoAnalyze(config),
    port: PORT,
    devOrigins: config.devOrigins,
  });

  // Loopback only. Binding 0.0.0.0 would put an unauthenticated API that can
  // spend money and write to GitHub on every interface the machine has.
  serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, (info) => {
    console.log(`@reviewer/server listening on http://localhost:${info.port}`);
  });
}

void main();
