import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import { bootstrapAppearance, SettingsProvider } from "./lib/settings";
import "./index.css";

// Paint the stored theme/font before the first render rather than after it.
bootstrapAppearance();

// autoUpdate: the new service worker activates and takes over without
// prompting the user; we just log it so an update is visible in devtools.
registerSW({
  immediate: true,
  onRegisteredSW(swUrl) {
    console.log(`[pwa] service worker registered: ${swUrl}`);
  },
  onNeedRefresh() {
    console.log("[pwa] new content available, applying update");
  },
  onOfflineReady() {
    console.log("[pwa] app ready to work offline (static shell cached)");
  },
});

// autoUpdate's registerSW() calls skipWaiting()+clientsClaim() under the
// hood, so this is the actual "a new SW just took over" signal.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    console.log("[pwa] new service worker activated and took control");
  });
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 5_000,
      retry: 1,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <SettingsProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </SettingsProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
