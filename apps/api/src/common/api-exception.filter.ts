import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { ApiException } from './api-exception';

export type ErrorBody = { error: { code: string; message: string } };

/**
 * Codes for exceptions Nest raises itself — an unmatched route, a malformed
 * JSON body. Anything we throw deliberately carries its own code.
 */
const CODE_BY_STATUS: Record<number, string> = {
  400: 'invalid_request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  410: 'gone',
  413: 'payload_too_large',
  422: 'unprocessable_entity',
  429: 'rate_limited',
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const { status, body } = this.translate(exception, request);
    response.status(status).json(body);
  }

  private translate(exception: unknown, request: Request): { status: number; body: ErrorBody } {
    if (exception instanceof ApiException) {
      return {
        status: exception.getStatus(),
        body: { error: { code: exception.code, message: exception.message } },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        status,
        body: { error: { code: codeFor(status), message: exception.message } },
      };
    }

    // Nothing below here was anticipated, so nothing below here is described to
    // the client: a pg error would otherwise name the constraint it violated.
    this.logger.error(
      `unhandled error on ${request.method} ${request.url}`,
      exception instanceof Error ? exception.stack : String(exception),
    );

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { error: { code: 'internal_error', message: 'Something went wrong.' } },
    };
  }
}

function codeFor(status: number): string {
  return CODE_BY_STATUS[status] ?? (status >= 500 ? 'internal_error' : 'error');
}
