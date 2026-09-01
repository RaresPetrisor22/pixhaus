import { z } from 'zod';

export const RegisterBody = z.object({
  studioName: z.string().trim().min(1).max(200),
  email: z.email().toLowerCase().max(254),
  password: z.string().min(12).max(200),
});

export type RegisterInput = z.infer<typeof RegisterBody>;

export const VerifyEmailBody = z.object({
  token: z.string().min(1).max(200),
});

export type VerifyEmailInput = z.infer<typeof VerifyEmailBody>;

export const ResendVerificationBody = z.object({
  email: z.email().toLowerCase().max(254),
});

export type ResendVerificationInput = z.infer<typeof ResendVerificationBody>;

export const LoginBody = z.object({
  email: z.email().toLowerCase().max(254),
  // No min() here. Length rules belong on the password being set
  password: z.string().max(200),
});

export type LoginInput = z.infer<typeof LoginBody>;
