const POSTGRES_UNIQUE_VIOLATION = "23505";

function pgErrorCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  return (error as { code?: unknown }).code;
}

/** drizzle-orm wraps the raw `pg` error in a DrizzleQueryError whose own `.code` is
 * undefined — the Postgres error code lives one level down, on `.cause`. Checking
 * only the top-level error means a unique-violation is never recognized as one, and
 * surfaces as an unhandled 500 instead of a clean 409 (found the hard way in
 * OnboardingService — see its git history). */
export function isUniqueViolation(error: unknown): boolean {
  return pgErrorCode(error) === POSTGRES_UNIQUE_VIOLATION || pgErrorCode((error as { cause?: unknown })?.cause) === POSTGRES_UNIQUE_VIOLATION;
}
