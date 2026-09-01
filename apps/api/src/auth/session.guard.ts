import { HttpStatus, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ApiException } from '../common/api-exception';
import type { AuthenticatedRequest } from './principal';
import { IS_PUBLIC } from './public.decorator';
import { readSessionCookie } from './session-cookie';
import { SessionService } from './session.service';

function unauthenticated(): ApiException {
  return new ApiException(HttpStatus.UNAUTHORIZED, 'unauthenticated', 'Sign in to continue.');
}

/**
 * Registered globally, so every route is authenticated unless it carries
 * @Public().
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = readSessionCookie(request.headers.cookie);

    if (!token) {
      throw unauthenticated();
    }

    const principal = await this.sessions.resolve(token);

    // No cookie, an unknown cookie and an expired one are the same answer.
    if (!principal) {
      throw unauthenticated();
    }

    request.principal = principal;
    return true;
  }
}
