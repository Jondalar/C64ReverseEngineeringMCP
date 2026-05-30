import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./index.css";
// Spec 724B: scoped Live-runtime theme (everything under .wb-live). Only styles
// the Live tab in the v3 look; v1's own styling is untouched (no globals, no
// collisions — colliding class names stay v1 outside .wb-live).
import "./components/live-runtime.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
