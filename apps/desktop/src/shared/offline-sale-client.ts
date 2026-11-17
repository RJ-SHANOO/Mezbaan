import { invoke } from "@tauri-apps/api/core";
import type { CartLine } from "../pos/cart.js";

interface CartLineModifierWire {
  modifierOptionId: string;
  name: string;
  unitPriceMinor: string;
  currency: string;
}

interface CartLineWire {
  productId: string;
  name: string;
  quantity: number;
  unitPriceMinor: string;
  currency: string;
  modifiers: CartLineModifierWire[];
}

/** P2-45: the persisted result of a completed offline sale — every amount
 * is a decimal minor-units string, never a JS number. */
export interface OfflineInvoice {
  id: string;
  documentNumber: string;
  orderType: string;
  currency: string;
  subtotalMinor: string;
  serviceChargeMinor: string;
  taxBaseMinor: string;
  taxMinor: string;
  totalMinor: string;
}

function toWireLine(line: CartLine): CartLineWire {
  return {
    productId: line.productId,
    name: line.name,
    quantity: line.quantity,
    unitPriceMinor: line.unitPriceMinor,
    currency: line.currency,
    modifiers: line.modifiers.map((m) => ({ modifierOptionId: m.modifierOptionId, name: m.name, unitPriceMinor: m.unitPriceMinor, currency: m.currency })),
  };
}

/** P2-45: completes a sale entirely from local data (no network call) —
 * prices `lines` via the terminal's own cached tax config, mints a P1-28
 * document number, and persists the invoice locally. `idempotencyKey`
 * should be generated once per checkout attempt and reused across retries
 * (e.g. a double-click or a transient Tauri IPC error) — retrying the same
 * key returns the original invoice rather than creating a duplicate sale. */
export function completeOfflineSale(orderType: string, currency: string, lines: CartLine[], idempotencyKey: string): Promise<OfflineInvoice> {
  return invoke<OfflineInvoice>("complete_offline_sale", { orderType, currency, lines: lines.map(toWireLine), idempotencyKey });
}
