import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState, type FormEvent, type ReactElement, type ReactNode } from "react";
import { DeviceTokenResponseSchema } from "@mezbaan/contracts";
import { apiRequest, ApiError } from "./api-client.js";

type Status =
  | { kind: "checking" }
  | { kind: "needsPairing" }
  | { kind: "pairing" }
  | { kind: "paired" }
  | { kind: "error"; message: string };

interface PairingGateProps {
  /** Shown in the fallback UI, e.g. "POS terminal" or "kitchen display" — same
   * reason ErrorBoundary takes a module name. */
  deviceLabel: string;
  children: ReactNode;
}

/**
 * Gates a window's real content behind device pairing (P1-20): checks the OS
 * keychain (via the Rust `get_device_token` command) for a stored device token
 * on mount, and if there isn't one, shows a form to redeem a pairing code from
 * api-pos's `POST /devices/pair` — generated server-side by a restaurant admin —
 * before rendering `children`.
 */
export function PairingGate({ deviceLabel, children }: PairingGateProps): ReactElement {
  const [status, setStatus] = useState<Status>({ kind: "checking" });
  const [code, setCode] = useState("");

  useEffect(() => {
    let cancelled = false;
    invoke<string | null>("get_device_token")
      .then((token) => {
        if (!cancelled) setStatus(token ? { kind: "paired" } : { kind: "needsPairing" });
      })
      .catch((error: unknown) => {
        if (!cancelled) setStatus({ kind: "error", message: errorMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handlePair(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setStatus({ kind: "pairing" });
    try {
      const response = DeviceTokenResponseSchema.parse(
        await apiRequest("/devices/pair", { method: "POST", body: { pairingCode: code } }),
      );
      await invoke("store_device_token", { token: response.deviceToken });
      setStatus({ kind: "paired" });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  if (status.kind === "checking") {
    return <CenteredMessage>Checking pairing status…</CenteredMessage>;
  }
  if (status.kind === "paired") {
    return <>{children}</>;
  }

  const pending = status.kind === "pairing";
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-50 px-6 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand-purple text-xl font-bold text-white">M</span>
      <h1 className="text-xl font-semibold text-slate-900">Pair this {deviceLabel}</h1>
      <p className="max-w-sm text-sm text-slate-500">Enter the pairing code shown by your restaurant admin to connect this device.</p>
      <form onSubmit={handlePair} className="flex w-full max-w-xs flex-col gap-2">
        <input
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="Pairing code"
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          disabled={pending}
          autoFocus
        />
        <button
          type="submit"
          disabled={pending || code.trim().length === 0}
          className="rounded-lg bg-brand-purple px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {pending ? "Pairing…" : "Pair device"}
        </button>
      </form>
      {status.kind === "error" && <p className="max-w-sm text-xs text-red-600">{status.message}</p>}
    </div>
  );
}

function CenteredMessage({ children }: { children: ReactNode }): ReactElement {
  return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">{children}</div>;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : "Something went wrong.";
}
