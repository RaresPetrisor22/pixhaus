import { HttpStatus, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { GrantRequest } from '../auth/principal';
import { ApiException } from '../common/api-exception';
import type { Env } from '../config/env';
import { principalFromPayload, verifyClientToken } from './client-token';

export function readBearer(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) {
    return null;
  }

  return header.slice('Bearer '.length).trim() || null;
}

/**
 * The client plane's SessionGuard. The difference that matters: this one is a
 * signature check, so it costs no database round trip and can sit in front of
 * the per-thumbnail hot path.
 */
@Injectable()
export class ClientGuard implements CanActivate {
  private readonly secret: string;

  constructor(config: ConfigService<Env, true>) {
    this.secret = config.get('CLIENT_TOKEN_SECRET', { infer: true });
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<GrantRequest>();
    const token = readBearer(request.headers.authorization);
    const payload = token ? verifyClientToken(token, this.secret) : null;

    // A missing token, a forged one and an expired one are the same answer.
    if (!payload) {
      throw new ApiException(
        HttpStatus.UNAUTHORIZED,
        'unauthenticated',
        'Open your gallery link again.',
      );
    }

    request.grant = principalFromPayload(payload);
    return true;
  }
}
