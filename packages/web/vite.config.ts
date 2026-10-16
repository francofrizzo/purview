import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // No service worker: it served the old build until a hard reload, and
      // a local tool gains nothing from offline. This emits a sw.js that
      // unregisters the one browsers still have; the plugin stays for the
      // manifest.
      selfDestroying: true,
      injectRegister: false,
      manifest: {
        name: "Purview",
        short_name: "Purview",
        description: "A local-first PR review assistant.",
        start_url: "/",
        display: "standalone",
        background_color: "#0c0d10",
        theme_color: "#0c0d10",
        icons: [
          { src: "/pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "/pwa-512x512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/maskable-icon-192x192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "maskable",
          },
          {
            src: "/maskable-icon-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
    }),
  ],
  server: {
    port: 5179,
    proxy: {
      "/api": {
        // PURVIEW_PORT points the dev server at another backend (e.g. a scratch one).
        target: `http://localhost:${process.env.PURVIEW_PORT ?? 4779}`,
        changeOrigin: true,
      },
    },
  },
  test: {
    // The Playwright suite under e2e/ is not vitest's to run.
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
