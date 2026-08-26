import { Navigate, Route, Routes } from "react-router-dom";
import { ChatProvider } from "./lib/chat";
import { PrList } from "./routes/PrList";
import { PrView } from "./routes/PrView";
import { RepoSettingsPage } from "./routes/RepoSettings";
import { SettingsPage } from "./routes/Settings";

export function App() {
  return (
    <ChatProvider>
      <Routes>
      <Route path="/" element={<PrList />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/repo/:host/:owner/:repo/settings" element={<RepoSettingsPage />} />
      {/* key = host/owner/repo/number, kept as path segments */}
      <Route path="/pr/*" element={<PrView />} />
      <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ChatProvider>
  );
}
