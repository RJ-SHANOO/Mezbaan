import { z } from "zod";

export const CreateBranchSchema = z.object({
  name: z.string().min(1),
  timezone: z.string().min(1),
});
export type CreateBranch = z.infer<typeof CreateBranchSchema>;

export const UpdateBranchSchema = z.object({
  name: z.string().min(1).optional(),
  timezone: z.string().min(1).optional(),
  status: z.enum(["active", "inactive"]).optional(),
});
export type UpdateBranch = z.infer<typeof UpdateBranchSchema>;

export const BranchSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  timezone: z.string(),
  status: z.enum(["active", "inactive"]),
  // Sequential per restaurant, assigned at creation — the "B1" half of a P1-28
  // document number.
  branchNumber: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Branch = z.infer<typeof BranchSchema>;
