/**
 * Email Sender Service
 * 
 * Sends transactional emails (verification codes, password resets)
 * Separate from the email reading clients (GmailClient, OutlookClient)
 */

export interface EmailSender {
  sendVerificationEmail(email: string, code: string): Promise<void>;
  sendPasswordResetEmail(email: string, code: string): Promise<void>;
}

/**
 * Simple email sender using nodemailer (SMTP)
 * For production, consider SendGrid or AWS SES
 */
import nodemailer, { Transporter } from 'nodemailer';

export class EmailSenderService implements EmailSender {
  private transporter: Transporter | null = null;
  private enabled: boolean = false;

  constructor() {
    this.initialize();
  }

  private initialize(): void {
    const smtpHost = process.env.SMTP_HOST;
    const smtpPort = parseInt(process.env.SMTP_PORT || '587');
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    const smtpSecure = process.env.SMTP_SECURE === 'true';

    // Only initialize if SMTP is configured
    if (smtpHost && smtpUser && smtpPass) {
      this.transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpSecure, // true for 465, false for other ports
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
      });

      this.enabled = true;
      console.log('✅ Email sender service initialized');
    } else {
      console.warn('⚠️  SMTP not configured. Email sending disabled. Set SMTP_HOST, SMTP_USER, SMTP_PASS to enable.');
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

  private async sendEmail(
    to: string, 
    subject: string, 
    html: string, 
    text: string
  ): Promise<void> {
    if (!this.enabled || !this.transporter) {
      // In development, log the email instead of sending
      if (process.env.NODE_ENV === 'development') {
        console.log('📧 [DEV MODE] Email would be sent:');
        console.log(`   To: ${to}`);
        console.log(`   Subject: ${subject}`);
        console.log(`   Code: ${text.split(': ')[1]}`);
        return;
      }
      throw new Error('Email service not configured. Set SMTP environment variables.');
    }

    try {
      await this.transporter.sendMail({
        from: process.env.SMTP_FROM || '"Snack Track" <noreply@snacktrack.com>',
        to,
        subject,
        text,
        html,
      });
      console.log(`✅ Email sent to ${to}`);
    } catch (error) {
      console.error(`❌ Failed to send email to ${to}:`, error);
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
      </div>
    </div>
  </body>
</html>`;
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

