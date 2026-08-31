import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';

import { ZodBody } from '../common/zod-body.pipe';
import { VerifyEmailBody, type VerifyEmailInput } from './auth.schemas';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // POST defaults to 201; nothing was created here.
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  async verifyEmail(@Body(new ZodBody(VerifyEmailBody)) body: VerifyEmailInput) {
    await this.auth.verifyEmail(body.token);
    return { verified: true };
  }
}
