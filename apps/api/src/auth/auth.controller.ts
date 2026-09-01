import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { ZodBody } from '../common/zod-body.pipe';
import {
  LoginBody,
  RegisterBody,
  ResendVerificationBody,
  VerifyEmailBody,
  type LoginInput,
  type RegisterInput,
  type ResendVerificationInput,
  type VerifyEmailInput,
} from './auth.schemas';
import { AuthService } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import type { StudioUserPrincipal } from './principal';
import { Public } from './public.decorator';
import { SESSION_COOKIE } from './session-cookie';
import { SessionService } from './session.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Public()
  @Post('register')
  register(@Body(new ZodBody(RegisterBody)) body: RegisterInput) {
    return this.auth.register(body);
  }

  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  async verifyEmail(@Body(new ZodBody(VerifyEmailBody)) body: VerifyEmailInput) {
    await this.auth.verifyEmail(body.token);
    return { verified: true };
  }

  // 202: we accepted the request. Whether an email went anywhere is
  // deliberately not disclosed.
  @Public()
  @Post('resend-verification')
  @HttpCode(HttpStatus.ACCEPTED)
  async resendVerification(
    @Body(new ZodBody(ResendVerificationBody)) body: ResendVerificationInput,
  ) {
    await this.auth.resendVerification(body.email);
    return { sent: true };
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(new ZodBody(LoginBody)) body: LoginInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { token, profile } = await this.auth.login(body, {
      ip: request.ip,
      userAgent: request.get('user-agent'),
    });

    response.cookie(SESSION_COOKIE, token, this.sessions.cookieOptions);
    return profile;
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @CurrentUser() principal: StudioUserPrincipal,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.auth.logout(principal);
    response.clearCookie(SESSION_COOKIE, this.sessions.cookieOptions);
  }

  @Delete('sessions')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logoutEverywhere(
    @CurrentUser() principal: StudioUserPrincipal,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.auth.logoutEverywhere(principal);
    response.clearCookie(SESSION_COOKIE, this.sessions.cookieOptions);
  }

  @Get('me')
  me(@CurrentUser() principal: StudioUserPrincipal) {
    return this.auth.me(principal);
  }
}
