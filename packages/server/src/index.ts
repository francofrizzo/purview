import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const PORT = Number(process.env.REVIEWER_PORT ?? 4779);

const app = createApp({
  // Set REVIEWER_AUTO_ANALYZE=0 to run the server without ever spawning Claude
  // on init/refresh (manual POST /analyze still works).
  autoAnalyze: process.env.REVIEWER_AUTO_ANALYZE !== "0",
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`@reviewer/server listening on http://localhost:${info.port}`);
});
