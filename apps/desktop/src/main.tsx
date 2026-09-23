import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { log } from "./lib/logger";

// Non-React failures (listener exceptions, async store bugs) never surface in
// the UI; route them through the redacted app-log channel like ui.crash does.
window.addEventListener("error", (event) => {
  log.error("window.error", { message: event.message });
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  log.error("window.unhandledrejection", { message: reason instanceof Error ? reason.message : String(reason) });
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
