import { z } from "zod";

export const LoginRequestSchema = z.object({
  restaurantSlug: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const RefreshRequestSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

export const LogoutRequestSchema = z.object({
  refreshToken: z.string().min(1),
});
export type LogoutRequest = z.infer<typeof LogoutRequestSchema>;

export const PasswordResetRequestSchema = z.object({
  restaurantSlug: z.string().min(1),
  email: z.string().email(),
});
export type PasswordResetRequest = z.infer<typeof PasswordResetRequestSchema>;

export const PasswordResetConfirmSchema = z.object({
  resetToken: z.string().min(1),
  newPassword: z.string().min(8),
});
export type PasswordResetConfirm = z.infer<typeof PasswordResetConfirmSchema>;
