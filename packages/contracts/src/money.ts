import { z } from "zod";
import { money, type Money } from "@mezbaan/domain";
import { CurrencyCodeSchema } from "./currency.js";

const MINOR_UNITS_PATTERN = /^-?\d+$/;

/** The JSON-safe shape of a Money value — amountMinor as a decimal string, since JSON
 * has no bigint type. */
export const MoneyWireSchema = z.object({
  amountMinor: z.string().regex(MINOR_UNITS_PATTERN, "amountMinor must be an integer string"),
  currency: CurrencyCodeSchema,
});
export type MoneyWire = z.infer<typeof MoneyWireSchema>;

/** Parses the wire format into a domain Money (validates the currency along the way). */
export const MoneySchema = MoneyWireSchema.transform((wire): Money => money(BigInt(wire.amountMinor), wire.currency));

/** The inverse of MoneySchema: encodes a domain Money for JSON. Not a Zod schema — Zod
 * validates input, it doesn't serialize output. */
export function serializeMoney(m: Money): MoneyWire {
  return { amountMinor: m.amountMinor.toString(), currency: m.currency };
}
