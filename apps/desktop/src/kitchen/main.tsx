import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "../shared/ErrorBoundary.js";
import { PairingGate } from "../shared/PairingGate.js";
import { App } from "./App.js";
import "../index.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("kitchen/main.tsx: #root element not found");

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary module="Kitchen">
      <PairingGate deviceLabel="kitchen display">
        <App />
      </PairingGate>
    </ErrorBoundary>
  </StrictMode>,
);
