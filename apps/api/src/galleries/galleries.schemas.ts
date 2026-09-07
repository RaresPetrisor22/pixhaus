import { z } from 'zod';

const title = z.string().trim().min(1).max(200);

const status = z.enum(['draft', 'active', 'archived']);

export const CreateGalleryBody = z.object({ title });

export type CreateGalleryInput = z.infer<typeof CreateGalleryBody>;

export const UpdateGalleryBody = z
  .object({ title: title.optional(), status: status.optional() })
  .refine((body) => body.title !== undefined || body.status !== undefined, {
    message: 'provide title, status, or both',
  });

export type UpdateGalleryInput = z.infer<typeof UpdateGalleryBody>;

export const ListGalleriesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});

export type ListGalleriesInput = z.infer<typeof ListGalleriesQuery>;
