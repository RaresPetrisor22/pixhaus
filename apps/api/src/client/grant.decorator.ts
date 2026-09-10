import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type { GrantPrincipal, GrantRequest } from '../auth/principal';

/** The client-plane @CurrentUser(). ClientGuard has already run. */
export const Grant = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<GrantRequest>();

  if (!request.grant) {
    throw new Error('@Grant() used on a route without ClientGuard');
  }

  return request.grant satisfies GrantPrincipal;
});
