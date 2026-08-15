import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

/*
 * Register the service worker so West Peek OS is installable and opens offline (P20, GAP-20).
 * It caches the app SHELL only — /api/* is never cached, so institutional state is never served
 * stale from a device. Registration failure is non-fatal: the app works without it.
 */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      /* offline shell unavailable; the app still works online */
    });
  });
}
