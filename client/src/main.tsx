// Stylesheet order is the cascade order: library defaults, then elements, then shared
// classes, then each component's own file as its module loads.
import "react-mosaic-component/react-mosaic-component.css";
import "./styles/base.css";
import "./styles/shared.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
