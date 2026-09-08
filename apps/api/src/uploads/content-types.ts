/**
 * The image types we accept.
 */
export const ACCEPTED_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/tiff',
] as const;

export type AcceptedContentType = (typeof ACCEPTED_CONTENT_TYPES)[number];

export function isAcceptedContentType(value: string): value is AcceptedContentType {
  return (ACCEPTED_CONTENT_TYPES as readonly string[]).includes(value);
}
