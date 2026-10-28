import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { configDefaults } from "vitest/config";
import { VitePWA } from "vite-plugin-pwa";

/**
 * In mock mode (`VITE_MOCK=1`) there is no backend behind `/api`, but the
 * page still asks `/api/prs/:key/image?url=…` for GitHub-hosted pictures (see
 * src/api/client.ts `remoteImageSrc`). This answers with a stand-in SVG so the
 * mock app, and the e2e suite, show a picture there.
 */
function mockRemoteImages(): Plugin {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120">',
    '<rect width="240" height="120" rx="8" fill="#dbeafe"/>',
    '<rect x="24" y="24" width="72" height="32" rx="4" fill="#3b82f6"/>',
    '<rect x="144" y="64" width="72" height="32" rx="4" fill="#3b82f6"/>',
    '<path d="M96 40 H120 V80 H144" fill="none" stroke="#1e3a8a" stroke-width="3"/>',
    "</svg>",
  ].join("");
  return {
    name: "purview:mock-remote-images",
    apply: () => process.env.VITE_MOCK === "1",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!/^\/api\/prs\/[^/]+\/image\?/.test(req.url ?? "")) return next();
        res.statusCode = 200;
        res.setHeader("content-type", "image/svg+xml");
        res.setHeader("content-security-policy", "sandbox");
        res.end(svg);
      });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    mockRemoteImages(),
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
    // A supervised orb preview exposes this exact host; local development is unchanged.
    allowedHosts: process.env.PUBLIC_URL ? [new URL(process.env.PUBLIC_URL).hostname] : undefined,
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
    // The header logo is inlined whatever its size: on a cold load the home
    // page otherwise paints its header before the image request lands.
    assetsInlineLimit: (file) => (/\/assets\/logo-(dark|light)\.png$/.test(file) ? true : undefined),
  },
});
