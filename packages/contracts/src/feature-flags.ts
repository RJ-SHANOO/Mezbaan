import { z } from "zod";

// Free text, not a closed enum: new modules arrive over Phases 2-4 and a fixed enum
// would need a migration every time one does. Format is still constrained so values
// stay predictable and greppable alongside the existing pos./inventory./etc.
// permission-key vocabulary (packages/db/src/seed.ts).
export const ModuleKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, "must be lowercase snake_case, e.g. \"inventory\" or \"qr_ordering\"");
export type ModuleKey = z.infer<typeof ModuleKeySchema>;

export const SetFeatureFlagSchema = z.object({
  enabled: z.boolean(),
});
export type SetFeatureFlag = z.infer<typeof SetFeatureFlagSchema>;

export const FeatureFlagSchema = z.object({
  id: z.string().uuid(),
  restaurantId: z.string().uuid(),
  moduleKey: ModuleKeySchema,
  enabled: z.boolean(),
  updatedByUserId: z.string().uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type FeatureFlag = z.infer<typeof FeatureFlagSchema>;
