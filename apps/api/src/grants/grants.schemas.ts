import { z } from 'zod';

import { RIGHT_NAMES } from '../authz/rights';

export const CreateGrantBody = z.object({
  audienceEmail: z.email().toLowerCase().max(254),

  // A grant that cannot browse is not a share link, so `view` is not optional.
  rights: z
    .array(z.enum(RIGHT_NAMES))
    .min(1)
    .refine((rights) => rights.includes('view'), { message: 'must include view' }),

  expiresAt: z.iso
    .datetime()
    .transform((value) => new Date(value))
    .refine((date) => date.getTime() > Date.now(), { message: 'must be in the future' }),

  label: z.string().trim().max(200).optional(),
});

export type CreateGrantInput = z.infer<typeof CreateGrantBody>;
