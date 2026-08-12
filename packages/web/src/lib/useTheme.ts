import { useEffect, useState } from "react";
import type { ThemeName } from "./highlight";

const query = "(prefers-color-scheme: light)";

export function useTheme(): ThemeName {
  const [theme, setTheme] = useState<ThemeName>(() =>
    typeof window !== "undefined" && window.matchMedia(query).matches ? "light" : "dark",
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setTheme(mql.matches ? "light" : "dark");
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return theme;
}
