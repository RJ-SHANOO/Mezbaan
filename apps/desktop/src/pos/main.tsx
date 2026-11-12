import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BootHealthReporter } from "../shared/BootHealthReporter.js";
import { ErrorBoundary } from "../shared/ErrorBoundary.js";
import { PairingGate } from "../shared/PairingGate.js";
import { queryClient } from "../shared/query-client.js";
import { UpdateChecker } from "../shared/UpdateChecker.js";
import { App } from "./App.js";
import "../index.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("pos/main.tsx: #root element not found");

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary module="POS">
      <BootHealthReporter />
      <PairingGate deviceLabel="POS terminal">
        <UpdateChecker />
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </PairingGate>
    </ErrorBoundary>
  </StrictMode>,
);
