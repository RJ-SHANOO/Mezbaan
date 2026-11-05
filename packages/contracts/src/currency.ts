import { z } from "zod";
import { isSupportedCurrency } from "@mezbaan/domain";

export const CurrencyCodeSchema = z.string().refine(isSupportedCurrency, {
  message: "Unsupported currency code",
});
export type CurrencyCode = z.infer<typeof CurrencyCodeSchema>;
