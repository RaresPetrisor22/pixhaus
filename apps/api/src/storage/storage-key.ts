/**
 * Object keys.
 **/

export type RenditionKind = 'thumb' | 'grid' | 'preview';

export function studioPrefix(studioId: string): string {
  return `studios/${studioId}/`;
}

/** Contains the asset id, so it is unique without a unique index to prove it. */
export function originalKey(studioId: string, galleryId: string, assetId: string): string {
  return `${studioPrefix(studioId)}galleries/${galleryId}/originals/${assetId}`;
}

export function renditionKey(
  studioId: string,
  galleryId: string,
  assetId: string,
  kind: RenditionKind,
): string {
  return `${studioPrefix(studioId)}galleries/${galleryId}/renditions/${assetId}/${kind}.webp`;
}

/**
 * Returns true if the key is within the studio's namespace.
 *
 * The server picks every key, but this is
 * what a delete or a presign asserts before acting on a key read from a row.
 */
export function isWithinStudio(key: string, studioId: string): boolean {
  return key.startsWith(studioPrefix(studioId));
}
