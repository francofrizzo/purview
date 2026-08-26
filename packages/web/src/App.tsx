import { Navigate, Route, Routes, matchPath, useLocation, type Location } from "react-router-dom";
import { ChatProvider } from "./lib/chat";
import { PrList } from "./routes/PrList";
import { PrView } from "./routes/PrView";
import { RepoSettingsModal } from "./routes/RepoSettings";
import { SettingsModal } from "./routes/Settings";

/** Routes that render as an overlay instead of replacing the page. */
const MODAL_PATHS = ["/settings", "/repo/:host/:owner/:repo/settings"];

export function App() {
  const location = useLocation();
  const background = (location.state as { background?: Location } | null)?.background;
  const isModal = MODAL_PATHS.some((p) => matchPath(p, location.pathname));

  // A modal route never renders on its own: it renders over the page it was
  // opened from, or — when the URL was deep-linked — over the home route, which
  // keeps the address bar intact while still showing something underneath.
  const base: Location = isModal
    ? (background ?? { ...location, pathname: "/", search: "", hash: "", state: null })
    : location;

  return (
    <ChatProvider>
      <Routes location={base}>
        <Route path="/" element={<PrList />} />
        {/* key = host/owner/repo/number, kept as path segments */}
        <Route path="/pr/*" element={<PrView />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      <Routes>
        <Route path="/settings" element={<SettingsModal />} />
        <Route path="/repo/:host/:owner/:repo/settings" element={<RepoSettingsModal />} />
        <Route path="*" element={null} />
      </Routes>
    </ChatProvider>
  );
}
