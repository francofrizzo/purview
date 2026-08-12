import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const PORT = 4779;

const app = createApp();

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`@reviewer/server listening on http://localhost:${info.port}`);
});
