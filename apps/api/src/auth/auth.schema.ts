import { z } from 'zod';

export const RegisterBody = z.object({
  studioName: z.string().trim().min(1).max(200),
  email: z.email().toLowerCase().max(254),
  password: z.string().min(12).max(200),
});

export type RegisterInput = z.infer<typeof RegisterBody>;
