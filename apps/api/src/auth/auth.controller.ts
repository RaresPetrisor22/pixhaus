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
  UseGuards,
} from '@nestjs/common';
import { Throttle, minutes } from '@nestjs/throttler';
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
import { EmailThrottlerGuard } from './email-throttler.guard';
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
  @Throttle({ default: { limit: 5, ttl: minutes(60) } })
  @Post('register')
  register(@Body(new ZodBody(RegisterBody)) body: RegisterInput) {
    return this.auth.register(body);
  }

  // Loose: the token is 256 bits, so this is about noise, not guessing.
  @Public()
  @Throttle({ default: { limit: 30, ttl: minutes(60) } })
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  async verifyEmail(@Body(new ZodBody(VerifyEmailBody)) body: VerifyEmailInput) {
    await this.auth.verifyEmail(body.token);
    return { verified: true };
  }

  // 202: we accepted the request; whether an email went anywhere is not
  // disclosed. Tightly throttled, because it sends mail to an address the
  // caller names -- otherwise it is a way to spam someone else's inbox.
  @Public()
  @UseGuards(EmailThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: minutes(60) }, email: { limit: 3, ttl: minutes(60) } })
  @Post('resend-verification')
  @HttpCode(HttpStatus.ACCEPTED)
  async resendVerification(
    @Body(new ZodBody(ResendVerificationBody)) body: ResendVerificationInput,
  ) {
    await this.auth.resendVerification(body.email);
    return { sent: true };
  }

  // Two budgets, deliberately: per IP via the global guard, and per email via
  // EmailThrottlerGuard. Neither alone stops credential stuffing.
  @Public()
  @UseGuards(EmailThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: minutes(15) }, email: { limit: 10, ttl: minutes(15) } })
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
