import { randomBytes } from 'node:crypto';

const MAX_LENGTH = 63;

/** Combining accents, left behind by NFKD once the base letter is separated. */
const ACCENTS = /\p{Diacritic}/gu;

/**
 * A studio name turned into something matching the schema's
 * `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`. Not guaranteed unique — the caller
 * retries with withRandomSuffix on a unique violation.
 */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(ACCENTS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_LENGTH)
    .replace(/^-+|-+$/g, '');

  // A name of nothing but punctuation, or in a non-Latin script, leaves us
  // with nothing at all.
  return slug || 'studio';
}

export function withRandomSuffix(slug: string): string {
  const suffix = randomBytes(3).toString('hex');
  const stem = slug.slice(0, MAX_LENGTH - suffix.length - 1).replace(/-+$/, '') || 'studio';
  return `${stem}-${suffix}`;
}
