/**
 * A printable message for an error that may not have one.
 */
export function describeError(error: unknown): string {
  if (error instanceof AggregateError) {
    return error.errors.map(describeError).join('; ');
  }
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return error.message || code || error.name;
  }
  return String(error);
}
