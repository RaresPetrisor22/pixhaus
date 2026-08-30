import { HttpException, type HttpStatus } from '@nestjs/common';

export class ApiException extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: string,
    message: string,
  ) {
    super({ code, message }, status);
  }
}
