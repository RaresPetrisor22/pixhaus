/**
 * Opaque keyset cursors.
 */

/** The last row of a page, in whatever order the query used. */
export type Cursor = { sort: string; id: string };

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.sort}|${cursor.id}`, 'utf8').toString('base64url');
}

/**
 * Returns null for anything malformed rather than throwing. A bad cursor is a
 * client bug or a hand-edited URL;
 */
export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) {
    return null;
  }

  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const separator = decoded.indexOf('|');

  if (separator <= 0 || separator === decoded.length - 1) {
    return null;
  }

  return { sort: decoded.slice(0, separator), id: decoded.slice(separator + 1) };
}
