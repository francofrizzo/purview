import { defineConfig } from "@playwright/test";

/**
 * Browser regression suite against the mock app (VITE_MOCK=1): positions and
 * DOM state, no pixel screenshots. Runs on the user's installed Chrome, so no
 * browser download is needed. `pnpm test:e2e` from packages/web.
 */
const PORT = Number(process.env.E2E_PORT ?? 5421);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: 1,
  reporter: "list",
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: "chrome",
    headless: true,
    trace: "retain-on-failure",
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: `VITE_MOCK=1 pnpm exec vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
