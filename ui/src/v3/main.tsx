import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./style.css";
// BUG-011/012: shared visualization-panel CSS (heatmap / SVG disk / bank-chip
// grid / flow svg) so the v3 shell renders the same panels as v1. Globals are
// excluded from this file, so it won't clobber the v3 layout in style.css.
import "../components/workspace-panels.css";

const root = createRoot(document.getElementById("root")!);
root.render(<React.StrictMode><App /></React.StrictMode>);
