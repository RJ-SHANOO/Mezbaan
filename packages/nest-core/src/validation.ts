import { BadRequestException } from "@nestjs/common";
import type { ZodType } from "zod";

/** Converts a Zod failure into a 400 with a readable message list, instead of letting
 * it fall through to the catch-all exception filter as an unexpected 500 — bad input
 * is a client error, not a server bug, and shouldn't page anyone via Sentry. */
export function parseOrBadRequest<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new BadRequestException(result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
  }
  return result.data;
}
