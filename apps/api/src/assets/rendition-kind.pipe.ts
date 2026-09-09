import { HttpStatus, type PipeTransform } from '@nestjs/common';
import type { RenditionKind } from '@pixhaus/storage';

import { ApiException } from '../common/api-exception';

/** The same three values as `renditions.kind`'s CHECK constraint. */
const KINDS: ReadonlySet<string> = new Set<RenditionKind>(['thumb', 'grid', 'preview']);

/**
 * Validates the `:kind` path segment. A 404 rather than a 400, for the same
 * reason UuidParam gives one: `/renditions/huge` is a URL that does not exist,
 * not a malformed request.
 */
export class RenditionKindParam implements PipeTransform<string, RenditionKind> {
  transform(value: string): RenditionKind {
    if (!KINDS.has(value)) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'rendition_not_found',
        'No such rendition size.',
      );
    }

    return value as RenditionKind;
  }
}
