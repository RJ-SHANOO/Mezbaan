import { z } from "zod";

export const PrepTimeReportEntrySchema = z.object({
  stationId: z.string().uuid().nullable(),
  productId: z.string().uuid().nullable(),
  variantId: z.string().uuid().nullable(),
  ticketCount: z.number().int(),
  avgPrepTimeSeconds: z.number(),
  minPrepTimeSeconds: z.number(),
  maxPrepTimeSeconds: z.number(),
});
export type PrepTimeReportEntry = z.infer<typeof PrepTimeReportEntrySchema>;

export const PrepTimeReportSchema = z.object({
  businessDate: z.string(),
  entries: z.array(PrepTimeReportEntrySchema),
});
export type PrepTimeReport = z.infer<typeof PrepTimeReportSchema>;
