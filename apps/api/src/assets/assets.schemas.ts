import { z } from 'zod';

export const ListAssetsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});

export type ListAssetsInput = z.infer<typeof ListAssetsQuery>;
