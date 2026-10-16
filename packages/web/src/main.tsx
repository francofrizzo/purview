import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipLayer } from "./components/Tooltip";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
// Bundled UI face: served by Purview itself, so the chrome looks the same on a
// machine with no fonts installed. Weight axis only — width stays default.
import "@fontsource-variable/ibm-plex-sans/index.css";
import { App } from "./App";
import { bootstrapAppearance, SettingsProvider } from "./lib/settings";
import "./index.css";

// Paint the stored theme/font before the first render rather than after it.
bootstrapAppearance();

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
          <TooltipLayer />
        </BrowserRouter>
      </SettingsProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
