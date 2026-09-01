import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type { AuthenticatedRequest, StudioUserPrincipal } from './principal';

/**
 * The principal SessionGuard resolved, so handlers never touch the request.
 * Throwing here means the route is both @Public() and expecting a user, which
 * is a wiring mistake.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): StudioUserPrincipal => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!request.principal) {
      throw new Error('@CurrentUser() used on a route SessionGuard did not authenticate');
    }

    return request.principal;
  },
);
