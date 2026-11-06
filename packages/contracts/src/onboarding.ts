import { z } from "zod";

// Lowercase letters, digits and hyphens, no leading/trailing/doubled hyphen — this
// becomes the restaurant's login identifier (AuthService resolves it before the
// tenant context exists), so it needs to be URL/identifier-safe.
const SlugSchema = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Slug must be lowercase letters, numbers and single hyphens");

export const SignupRequestSchema = z.object({
  restaurantName: z.string().min(1),
  slug: SlugSchema,
  ownerEmail: z.string().email(),
  ownerPassword: z.string().min(8),
  ownerDisplayName: z.string().min(1),
  firstBranchName: z.string().min(1),
  timezone: z.string().min(1),
});
export type SignupRequest = z.infer<typeof SignupRequestSchema>;

// Deliberately no commissionRateBasisPoints field: the rate is server-owned platform
// policy (rule 7 — locked at registration), never something a signing-up restaurant
// supplies about itself.
export const SignupResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  restaurantId: z.string().uuid(),
  branchId: z.string().uuid(),
});
export type SignupResponse = z.infer<typeof SignupResponseSchema>;
