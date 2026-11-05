import { z } from "zod";

export const PageRequestSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type PageRequest = z.infer<typeof PageRequestSchema>;

/** Builds a response envelope schema for a page of `itemSchema` items. */
export function pageResponseSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().nullable(),
  });
}
