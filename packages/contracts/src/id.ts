import { z } from "zod";

/** UUIDv7 (RFC 9562): same layout as v4 except the version nibble is 7. CLAUDE.md
 * rule 9 requires every terminal write to carry a client-generated UUIDv7 id. */
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const UuidV7Schema = z.string().regex(UUID_V7_PATTERN, "Must be a UUIDv7");
export type UuidV7 = z.infer<typeof UuidV7Schema>;

/** A client-generated key used to make retries of the same operation idempotent (rule 9). */
export const IdempotencyKeySchema = z.string().min(1).max(255);
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;
