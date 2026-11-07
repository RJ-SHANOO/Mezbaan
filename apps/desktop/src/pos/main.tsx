import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "../shared/ErrorBoundary.js";
import { App } from "./App.js";
import "../index.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("pos/main.tsx: #root element not found");

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary module="POS">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
