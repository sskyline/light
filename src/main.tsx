import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { installMockBridge } from "./devMock";
import "./styles.css";

// In a plain browser (vite without Electron) there is no preload bridge, so
// install a dev-only mock that feeds representative states. Never runs inside
// the real app, where the preload defines window.light before this executes.
// In production builds `import.meta.env.DEV` is false, so this is dead code and
// the mock module gets tree-shaken out.
if (import.meta.env.DEV && !window.light) {
  installMockBridge();
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
