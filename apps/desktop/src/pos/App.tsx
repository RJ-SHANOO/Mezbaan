import type { ReactElement } from "react";
import { SyncStatusIndicator } from "../shared/SyncStatusIndicator.js";
import { PosScreen } from "./PosScreen.js";

export function App(): ReactElement {
  return (
    <>
      <PosScreen />
      <SyncStatusIndicator />
    </>
  );
}
