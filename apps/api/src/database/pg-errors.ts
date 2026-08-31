import type pg from 'pg';

const UNIQUE_VIOLATION = '23505';

/**
 * The name of the constraint a unique violation broke, or null if the error was
 * something else.
 */
export function uniqueViolation(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }

  const { code, constraint } = error as Partial<pg.DatabaseError>;
  return code === UNIQUE_VIOLATION ? (constraint ?? 'unknown') : null;
}
