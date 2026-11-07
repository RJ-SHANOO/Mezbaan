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
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Branch = z.infer<typeof BranchSchema>;
