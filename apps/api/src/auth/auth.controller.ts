import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';

import { ZodBody } from '../common/zod-body.pipe';
import {
  RegisterBody,
  ResendVerificationBody,
  VerifyEmailBody,
  type RegisterInput,
  type ResendVerificationInput,
  type VerifyEmailInput,
} from './auth.schemas';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // The only route here that really creates something, so the only 201.
  @Post('register')
  register(@Body(new ZodBody(RegisterBody)) body: RegisterInput) {
    return this.auth.register(body);
  }

  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  async verifyEmail(@Body(new ZodBody(VerifyEmailBody)) body: VerifyEmailInput) {
    await this.auth.verifyEmail(body.token);
    return { verified: true };
  }

  // 202: we accepted the request. Whether an email went anywhere is
  // deliberately not disclosed.
  @Post('resend-verification')
  @HttpCode(HttpStatus.ACCEPTED)
  async resendVerification(
    @Body(new ZodBody(ResendVerificationBody)) body: ResendVerificationInput,
  ) {
    await this.auth.resendVerification(body.email);
    return { sent: true };
  }
}
