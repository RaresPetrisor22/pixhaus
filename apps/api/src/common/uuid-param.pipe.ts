import { HttpStatus, type PipeTransform } from '@nestjs/common';

import { ApiException } from './api-exception';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates a UUID path parameter, answering with the caller's own not-found
 * code rather than a 400.
 */
export class UuidParam implements PipeTransform<string, string> {
  constructor(private readonly code: string) {}

  transform(value: string): string {
    if (!UUID.test(value)) {
      throw new ApiException(HttpStatus.NOT_FOUND, this.code, 'Not found.');
    }

    return value;
  }
}
