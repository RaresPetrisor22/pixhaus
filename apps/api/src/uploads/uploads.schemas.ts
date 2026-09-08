import { z } from 'zod';

/**
 * Shape only. Whether the size is under the ceiling and the type is one we
 * accept are policy questions, answered in the service so they can carry the
 * status codes docs/api.md specifies (413 and 422) rather than a blank 400.
 */
export const CreateUploadBody = z.object({
  filename: z.string().trim().min(1).max(255),
  size: z.coerce.number().int().positive(),
  contentType: z.string().min(1).max(100),
});

export type CreateUploadInput = z.infer<typeof CreateUploadBody>;
