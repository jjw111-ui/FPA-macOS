import React from "react";
import { createRoot } from "react-dom/client";
import { Studio } from "./Studio.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Studio />
  </React.StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js"));
}
