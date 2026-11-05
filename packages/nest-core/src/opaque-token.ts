import { createHash, randomBytes } from "node:crypto";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Refresh tokens and password-reset tokens are opaque random strings, not JWTs — they're
 * validated against a server-side row anyway (that's what makes them revocable), so
 * there's nothing to gain from a signed/self-describing format.
 *
 * They're prefixed with their restaurantId so the holder of a token round-trips the
 * tenant back to us: looking up the session/reset-token row needs RLS tenant context
 * set first, and this is the only data in hand to set it from (there's no JWT here to
 * read it off, unlike the access token in tenant-context.ts).
 */
export function generateOpaqueToken(restaurantId: string): string {
  return `${restaurantId}.${randomBytes(32).toString("hex")}`;
}

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Returns null for anything that isn't `<uuid>.<hex>` — never throws, since this runs
 * on untrusted client input. */
export function parseOpaqueTokenRestaurantId(token: string): string | null {
  const dotIndex = token.indexOf(".");
  if (dotIndex <= 0) return null;
  const restaurantId = token.slice(0, dotIndex);
  return UUID_PATTERN.test(restaurantId) ? restaurantId : null;
}
