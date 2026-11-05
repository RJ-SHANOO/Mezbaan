import { z } from "zod";

/** Matches the shape nest-core's GlobalExceptionFilter sends: Nest's own HttpException
 * responses carry `message` as either a string or a string array (e.g. validation
 * errors), plus an optional `error` label. */
export const ApiErrorSchema = z.object({
  statusCode: z.number().int(),
  message: z.union([z.string(), z.array(z.string())]),
  error: z.string().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
