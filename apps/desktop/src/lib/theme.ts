import { useEffect, useState } from "react";

function read(): "dark" | "light" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/** Resolved theme from `<html data-theme>`, kept live as settings change. */
export function useResolvedTheme() {
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}
