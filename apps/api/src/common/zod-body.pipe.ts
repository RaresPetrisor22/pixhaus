import { HttpStatus, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';

import { ApiException } from './api-exception';

/**
 * Validates a request body against a zod schema and returns the *parsed*
 * value, so coercions in the schema (trimming, lowercasing) reach the handler.
 *
 *   @Body(new ZodBody(RegisterBody)) body: RegisterInput
 */
export class ZodBody<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value);
    if (result.success) {
      return result.data;
    }

    // Field names only. The submitted values are not echoed back — one of them
    // is a password.
    const fields = [
      ...new Set(result.error.issues.map((issue) => issue.path.join('.') || '(body)')),
    ].join(', ');

    throw new ApiException(
      HttpStatus.BAD_REQUEST,
      'invalid_request',
      `Invalid or missing: ${fields}`,
    );
  }
}
