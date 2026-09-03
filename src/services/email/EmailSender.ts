/**
 * Email Sender Service
 *
 * Sends transactional emails (verification codes, password resets)
 * Separate from the email reading clients (GmailClient, OutlookClient)
 */

import type { TransactionalEmailPort } from '../ports/AuthPorts';

/**
 * Email sender using SendGrid REST API (preferred) or SMTP (nodemailer) as fallback
 * SendGrid REST API is more reliable on cloud platforms like Railway
 */
import nodemailer, { Transporter } from 'nodemailer';
import sgMail from '@sendgrid/mail';
import { config } from '../../config/AppConfig';
import { logger } from '../../config/logger';

interface SendGridTransporter {
  type: 'sendgrid';
  sgMail: typeof sgMail;
}

export class EmailSenderService implements TransactionalEmailPort {
  private transporter: Transporter | SendGridTransporter | null = null;
  private enabled: boolean = false;

  constructor() {
    this.initialize();
  }

  private initialize(): void {
    // Check for SendGrid API key (preferred) or SMTP credentials
    const mail = config.getMailConfig();
    const sendGridApiKey = mail.sendGridApiKey;
    const smtpHost = mail.smtpHost;
    const smtpUser = mail.smtpUser;
    const smtpPass = mail.smtpPassword;

    if (sendGridApiKey) {
      // Use SendGrid REST API (more reliable on cloud platforms)
      sgMail.setApiKey(sendGridApiKey);
      this.transporter = { type: 'sendgrid', sgMail };
      this.enabled = true;
      logger.info('Email sender initialized', { provider: 'sendgrid' });
    } else if (smtpHost && smtpUser && smtpPass) {
      // Fallback to SMTP if SendGrid API key not available
      this.transporter = nodemailer.createTransport({
        host: smtpHost,
        port: mail.smtpPort,
        secure: mail.smtpSecure,
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
      });
      this.enabled = true;
      logger.info('Email sender initialized', { provider: 'smtp' });
    } else {
      logger.warn('Email service not configured');
      this.enabled = false;
    }
  }

  async sendVerificationEmail(email: string, code: string): Promise<void> {
    const subject = 'Verify your Snack Track email';
    const html = this.getVerificationEmailTemplate(code);
    const text = `Your Snack Track verification code is: ${code}`;

    await this.sendEmail(email, subject, html, text);
  }

  async sendPasswordResetEmail(email: string, code: string): Promise<void> {
    const subject = 'Reset your Snack Track password';
    const html = this.getPasswordResetEmailTemplate(code);
    const text = `Your password reset code is: ${code}`;

    await this.sendEmail(email, subject, html, text);
  }

  async sendProviderLoginVerificationEmail(email: string, code: string): Promise<void> {
    const subject = 'Confirm your email for Microsoft sign-in';
    const html = this.getProviderLoginVerificationTemplate(code);
    const text = `Your Snack Track Microsoft sign-in verification code is: ${code}`;
    await this.sendEmail(email, subject, html, text);
  }

  async sendAdminInvitation(email: string, link: string): Promise<void> {
    await this.sendEmail(
      email,
      'You were invited to SnackTrack Admin',
      `<p>You were invited to administer SnackTrack.</p><p><a href="${link}">Accept invitation</a></p><p>This link expires in 24 hours.</p>`,
      `Accept your SnackTrack Admin invitation: ${link}\nThis link expires in 24 hours.`,
    );
  }

  async sendAdminPasswordReset(email: string, link: string): Promise<void> {
    await this.sendEmail(
      email,
      'Reset your SnackTrack Admin password',
      `<p>A password reset was requested for your SnackTrack Admin account.</p><p><a href="${link}">Reset password</a></p><p>This link expires in 30 minutes.</p>`,
      `Reset your SnackTrack Admin password: ${link}\nThis link expires in 30 minutes.`,
    );
  }

  private async sendEmail(to: string, subject: string, html: string, text: string): Promise<void> {
    if (!this.enabled || !this.transporter) {
      // In development, log the email instead of sending
      if (config.isDevelopment()) {
        logger.info('Transactional email skipped in development', {
          operation: 'send_transactional_email',
          outcome: 'not_configured',
        });
        return;
      }
      throw new Error(
        'Email service not configured. Set SENDGRID_API_KEY or SMTP environment variables.',
      );
    }

    try {
      const fromEmail = config.getMailConfig().from;

      // Use SendGrid REST API if available
      if (this.transporter && 'type' in this.transporter && this.transporter.type === 'sendgrid') {
        await this.transporter.sgMail.send({
          to,
          from: fromEmail,
          subject,
          text,
          html,
          // Add categories for tracking and filtering
          categories: ['transactional', 'snacktrack'],
          // Mark as important (helps with deliverability)
          headers: {
            'X-Entity-Ref-ID': 'snacktrack-transactional',
            'List-Unsubscribe': '<mailto:noreply@getsnacktrack.com>',
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        });
        logger.info('Transactional email sent', { provider: 'sendgrid' });
      } else {
        // Fallback to SMTP (nodemailer)
        const smtpTransporter = this.transporter as Transporter;
        await smtpTransporter.sendMail({
          from: fromEmail,
          to,
          subject,
          text,
          html,
        });
        logger.info('Transactional email sent', { provider: 'smtp' });
      }
    } catch (error) {
      logger.error('Transactional email delivery failed', { error });
      throw new Error('Failed to send email');
    }
  }

  private getVerificationEmailTemplate(code: string): string {
    return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
      .container { max-width: 600px; margin: 0 auto; padding: 20px; }
      .code { font-size: 32px; font-weight: bold; letter-spacing: 8px; 
              text-align: center; padding: 20px; background: #f5f5f5; 
              border-radius: 8px; margin: 20px 0; }
      .footer { margin-top: 30px; font-size: 12px; color: #666; }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Verify your email address</h1>
      <p>Thanks for signing up for Snack Track! Enter this code in the app to verify your email:</p>
      <div class="code">${code}</div>
      <p>This code expires in 15 minutes.</p>
      <p>If you didn't create a Snack Track account, you can safely ignore this email.</p>
      <div class="footer">
        <p>Snack Track Team</p>
        <p>This is an automated message from Snack Track. Please do not reply to this email.</p>
        <p>© ${new Date().getFullYear()} Snack Track - getsnacktrack.com</p>
      </div>
    </div>
  </body>
</html>`;
  }

  private getPasswordResetEmailTemplate(code: string): string {
    return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
      .container { max-width: 600px; margin: 0 auto; padding: 20px; }
      .code { font-size: 32px; font-weight: bold; letter-spacing: 8px; 
              text-align: center; padding: 20px; background: #f5f5f5; 
              border-radius: 8px; margin: 20px 0; }
      .footer { margin-top: 30px; font-size: 12px; color: #666; }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Reset your password</h1>
      <p>We received a request to reset your Snack Track password. Enter this code in the app:</p>
      <div class="code">${code}</div>
      <p>This code expires in 15 minutes.</p>
      <p>If you didn't request a password reset, you can safely ignore this email.</p>
      <div class="footer">
        <p>Snack Track Team</p>
        <p>This is an automated message from Snack Track. Please do not reply to this email.</p>
        <p>© ${new Date().getFullYear()} Snack Track - getsnacktrack.com</p>
      </div>
    </div>
  </body>
</html>`;
  }

  private getProviderLoginVerificationTemplate(code: string): string {
    return `<!DOCTYPE html>
<html>
  <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
    <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
      <h1>Confirm your email</h1>
      <p>Enter this code in Snack Track to finish signing in with Microsoft:</p>
      <div style="font-size: 32px; font-weight: bold; letter-spacing: 8px; text-align: center; padding: 20px; background: #f5f5f5; border-radius: 8px; margin: 20px 0;">${code}</div>
      <p>This code expires in 15 minutes. If you did not try to sign in, you can ignore this message.</p>
    </div>
  </body>
</html>`;
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}
