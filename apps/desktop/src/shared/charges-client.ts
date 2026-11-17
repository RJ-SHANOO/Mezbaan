import { invoke } from "@tauri-apps/api/core";

/** P2-45: the result of pricing one sale's subtotal — every amount is a
 * decimal minor-units string (the same JSON-safe wire format
 * packages/contracts' MoneyWireSchema uses), never a JS number. */
export interface ChargesResult {
  subtotal: string;
  serviceCharge: string;
  taxBase: string;
  tax: string;
  total: string;
}

/** P2-45: prices `subtotalMinor` for `orderType` using the already-synced tax
 * config cached locally (menu-client.ts's getTaxConfig) — the same
 * packages/domain computeCharges logic ported to Rust, so this produces
 * exactly the number the server would have, with no network call.
 *
 * Rejects if this order type's tax config was never synced (a fresh
 * terminal that hasn't pulled a snapshot yet) — call syncMenu first in that
 * case, rather than treating the rejection as "no tax applies". */
export function computeOfflineCharges(orderType: string, subtotalMinor: string): Promise<ChargesResult> {
  return invoke<ChargesResult>("compute_offline_charges", { orderType, subtotalMinor });
}
