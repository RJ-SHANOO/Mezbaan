import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState, type ReactElement } from "react";

interface SyncStatus {
  pendingCount: number;
  lastSuccessfulSyncAt: string | null;
  /** null until the very first sync attempt this install has ever made. */
  online: boolean | null;
}

const POLL_INTERVAL_MS = 15_000;

/**
 * P1-29: a small, always-visible readout of online state, pending-operation
 * count and last successful sync. Polls get_sync_status (sync_status.rs)
 * rather than reacting to a push from the sync client, since this is just a
 * status display, not something anything else needs to react to.
 */
export function SyncStatusIndicator(): ReactElement | null {
  const [status, setStatus] = useState<SyncStatus | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll(): Promise<void> {
      try {
        const next = await invoke<SyncStatus>("get_sync_status");
        if (!cancelled) setStatus(next);
      } catch (error) {
        console.error("failed to read sync status:", error);
      }
    }

    void poll();
    const interval = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (!status) return null;

  const label = status.online === null ? "Not yet synced" : status.online ? "Online" : "Offline";
  const dotColor = status.online === null ? "bg-slate-400" : status.online ? "bg-emerald-500" : "bg-red-500";

  return (
    <div className="fixed bottom-2 right-2 flex items-center gap-2 rounded-lg bg-white px-3 py-1.5 text-xs text-slate-600 shadow">
      <span className={`h-2 w-2 rounded-full ${dotColor}`} />
      <span>{label}</span>
      {status.pendingCount > 0 && <span className="font-medium">{status.pendingCount} pending</span>}
      {status.lastSuccessfulSyncAt && (
        <span className="text-slate-400">last synced {new Date(status.lastSuccessfulSyncAt).toLocaleTimeString()}</span>
      )}
    </div>
  );
}
