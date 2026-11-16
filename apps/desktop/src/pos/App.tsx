import { useState, type ReactElement } from "react";
import { PrinterSetupScreen } from "../shared/PrinterSetupScreen.js";
import { SyncStatusIndicator } from "../shared/SyncStatusIndicator.js";
import { PosScreen } from "./PosScreen.js";

export function App(): ReactElement {
  const [printerSetupOpen, setPrinterSetupOpen] = useState(false);

  return (
    <>
      <PosScreen />
      <SyncStatusIndicator />
      {/* P2-35: no real settings menu exists yet — a plain corner button is
       * the simplest honest way to reach the printer setup screen until one
       * does, without blocking this task on building full navigation. */}
      <button
        type="button"
        onClick={() => setPrinterSetupOpen(true)}
        className="fixed bottom-2 left-2 rounded-lg bg-white px-3 py-1.5 text-xs text-slate-600 shadow hover:bg-slate-50"
      >
        Printer Setup
      </button>
      {printerSetupOpen && <PrinterSetupScreen onClose={() => setPrinterSetupOpen(false)} />}
    </>
  );
}
