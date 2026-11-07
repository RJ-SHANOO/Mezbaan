import { z } from "zod";

// super_admin is a platform-level role — never assignable from inside a restaurant's
// own admin screens, so it's deliberately excluded from this enum.
export const InvitableRoleKeySchema = z.enum(["owner", "branch_manager", "cashier", "kitchen_staff"]);
export type InvitableRoleKey = z.infer<typeof InvitableRoleKeySchema>;

export const InviteUserSchema = z.object({
  email: z.string().email(),
  roleKey: InvitableRoleKeySchema,
  branchId: z.string().uuid().optional(),
});
export type InviteUser = z.infer<typeof InviteUserSchema>;

export const AcceptInviteSchema = z.object({
  inviteToken: z.string().min(1),
  displayName: z.string().min(1),
  password: z.string().min(8),
});
export type AcceptInvite = z.infer<typeof AcceptInviteSchema>;

export const UserSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  displayName: z.string(),
  roleKey: z.string(),
  branchId: z.string().uuid().nullable(),
  status: z.enum(["active", "disabled"]),
});
export type User = z.infer<typeof UserSchema>;

export const PendingInvitationSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  roleKey: z.string(),
  branchId: z.string().uuid().nullable(),
  expiresAt: z.string(),
});
export type PendingInvitation = z.infer<typeof PendingInvitationSchema>;
