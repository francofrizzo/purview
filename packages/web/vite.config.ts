import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // Only the built static shell (JS/CSS/fonts/icons/html) is precached.
      // `/api/**` (including the SSE chat/events streams) is deliberately
      // given NO runtimeCaching rule and is excluded from the precache
      // manifest, so the generated service worker's fetch handler never
      // matches those requests at all — they go straight to the network,
      // completely untouched by the SW (no interception, no buffering, no
      // risk to streaming). navigateFallbackDenylist additionally keeps the
      // SPA navigation fallback from ever answering an /api/* navigation.
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
      },
      manifest: {
        name: "Reviewer",
        short_name: "Reviewer",
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
        target: "http://localhost:4779",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
