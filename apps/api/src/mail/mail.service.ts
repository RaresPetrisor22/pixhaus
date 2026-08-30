import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';

import type { Env } from '../config/env';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transport: Transporter;
  private readonly from: string;
  private readonly appUrl: string;
  private readonly isProduction: boolean;

  constructor(config: ConfigService<Env, true>) {
    this.transport = createTransport(config.get('SMTP_URL', { infer: true }));
    this.from = config.get('SMTP_FROM', { infer: true });
    this.appUrl = config.get('APP_URL', { infer: true });
    this.isProduction = config.get('NODE_ENV', { infer: true }) === 'production';
  }

  /**
   * Throws if the message cannot be handed to the SMTP server. Callers decide
   * whether that should fail their request — registration does not, because
   * the account exists by then and resend-verification is the way back.
   */
  async sendVerificationEmail(to: string, token: string, ttlHours: number): Promise<void> {
    const url = `${this.appUrl}/verify-email?token=${encodeURIComponent(token)}`;

    // Saves opening Mailpit on every local registration.
    if (!this.isProduction) {
      this.logger.log(`verification link for ${to}: ${url}`);
    }

    await this.transport.sendMail({
      from: this.from,
      to,
      subject: 'Confirm your Pixhaus email address',
      text: [
        'Confirm your email address to finish setting up your Pixhaus studio:',
        '',
        url,
        '',
        `This link expires in ${ttlHours} hours and can be used once.`,
        'If you did not sign up, you can ignore this message.',
      ].join('\n'),
    });
  }
}
