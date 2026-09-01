import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'auth:public';

/**
 * Opts a route out of SessionGuard, which is registered globally. Routes are
 * authenticated unless they say otherwise, so a new one cannot be exposed by
 * forgetting a guard — only by adding this.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);
