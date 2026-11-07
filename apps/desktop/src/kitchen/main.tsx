import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BootHealthReporter } from "../shared/BootHealthReporter.js";
import { ErrorBoundary } from "../shared/ErrorBoundary.js";
import { PairingGate } from "../shared/PairingGate.js";
import { UpdateChecker } from "../shared/UpdateChecker.js";
import { App } from "./App.js";
import "../index.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("kitchen/main.tsx: #root element not found");

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary module="Kitchen">
      <BootHealthReporter />
      <PairingGate deviceLabel="kitchen display">
        <UpdateChecker />
        <App />
      </PairingGate>
    </ErrorBoundary>
  </StrictMode>,
);
