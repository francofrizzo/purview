import { Navigate, Route, Routes } from "react-router-dom";
import { PrList } from "./routes/PrList";
import { PrView } from "./routes/PrView";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<PrList />} />
      {/* key = host/owner/repo/number, kept as path segments */}
      <Route path="/pr/*" element={<PrView />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
