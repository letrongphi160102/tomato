import type { Transporter } from 'nodemailer';
import { describe, expect, it, vi } from 'vitest';

import {
  EmailDeliveryError,
  SmtpEmailAdapter,
  buildDuplicateRegistrationEmail,
  buildPasswordChangeOtpEmail,
  buildPasswordChangedAlertEmail,
  buildPasswordResetAlertEmail,
  buildPasswordResetLinkEmail,
  buildVerificationOtpEmail,
  createEmailProvider,
  escapeHtml,
} from '@/core/email';

describe('Unit M2: Email Templates & SmtpEmailAdapter', () => {
  it('escapeHtml vô hiệu hóa các ký tự HTML đặc biệt chống HTML Injection', () => {
    expect(escapeHtml(`<script>alert("xss")</script> & 'test'`)).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; &#39;test&#39;',
    );
  });

  it('buildVerificationOtpEmail tạo cả HTML sạch và Plain Text chứa OTP & thời hạn', () => {
    const rendered = buildVerificationOtpEmail({
      displayName: '<b>Hacker</b>',
      otpCode: '084921',
      expiresInMinutes: 15,
    });

    expect(rendered.subject).toContain('084921');
    expect(rendered.html).toContain('084921');
    expect(rendered.html).toContain('15 phút');
    expect(rendered.html).toContain('&lt;b&gt;Hacker&lt;/b&gt;');
    expect(rendered.html).not.toContain('<b>Hacker</b>');
    expect(rendered.text).toContain('084921');
    expect(rendered.text).toContain('15 phút');
  });

  it('buildDuplicateRegistrationEmail escape displayName và chặn URL nguy hiểm (javascript:)', () => {
    const safeEmail = buildDuplicateRegistrationEmail({
      displayName: 'Minh <Anh>',
      appUrl: 'https://tomato.example.com',
    });
    expect(safeEmail.html).toContain('Minh &lt;Anh&gt;');
    expect(safeEmail.html).toContain('https://tomato.example.com/');
    expect(safeEmail.text).toContain('https://tomato.example.com/');

    const unsafeUrlEmail = buildDuplicateRegistrationEmail({
      displayName: 'Minh Anh',
      appUrl: 'javascript:alert(1)',
    });
    expect(unsafeUrlEmail.html).not.toContain('javascript:');
    expect(unsafeUrlEmail.text).not.toContain('javascript:');
  });

  it('SmtpEmailAdapter gửi đúng tham số qua transporter và bọc lỗi thành EmailDeliveryError', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: 'msg-1' });
    const verify = vi.fn().mockResolvedValue(true);
    const close = vi.fn();

    const fakeTransporter = { sendMail, verify, close } as unknown as Transporter;
    const adapter = new SmtpEmailAdapter({
      host: '127.0.0.1',
      port: 1025,
      secure: false,
      from: 'Tomato <no-reply@tomato.local>',
      transporter: fakeTransporter,
    });

    await adapter.send({
      to: 'user@example.com',
      subject: 'Test Subject',
      html: '<p>Hello</p>',
      text: 'Hello',
    });

    expect(sendMail).toHaveBeenCalledWith({
      from: 'Tomato <no-reply@tomato.local>',
      to: 'user@example.com',
      subject: 'Test Subject',
      html: '<p>Hello</p>',
      text: 'Hello',
    });
    expect(await adapter.verify()).toBe(true);
    await adapter.close();
    expect(close).toHaveBeenCalledTimes(1);

    // Khi SMTP lỗi phải ném EmailDeliveryError và không lộ nội dung OTP trong thông điệp lỗi.
    sendMail.mockRejectedValueOnce(
      Object.assign(new Error('Connection refused'), { code: 'ECONNREFUSED' }),
    );
    await expect(
      adapter.send({
        to: 'user@example.com',
        subject: 'OTP 999888',
        html: '<p>999888</p>',
        text: '999888',
      }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof EmailDeliveryError &&
        error.provider === 'smtp' &&
        !error.message.includes('999888')
      );
    });
  });

  it('createEmailProvider tạo đúng adapter cho mailpit, gmail, brevo và smtp tương thích ngược', () => {
    const smtpProvider = createEmailProvider({
      EMAIL_PROVIDER: 'smtp',
      EMAIL_FROM: 'Tomato <no-reply@tomato.local>',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: 1025,
      SMTP_SECURE: false,
    });
    expect(smtpProvider.provider).toBe('smtp');

    const mailpitProvider = createEmailProvider({
      EMAIL_PROVIDER: 'mailpit',
      EMAIL_FROM: 'Tomato <no-reply@tomato.local>',
      SMTP_SECURE: false,
    });
    expect(mailpitProvider.provider).toBe('smtp');

    const gmailProvider = createEmailProvider({
      EMAIL_PROVIDER: 'gmail',
      EMAIL_FROM: 'Tomato <tomato@gmail.com>',
      SMTP_SECURE: true,
      SMTP_USER: 'tomato@gmail.com',
      SMTP_PASS: 'synthetic-gmail-app-password',
    });
    expect(gmailProvider.provider).toBe('gmail');

    const brevoProvider = createEmailProvider({
      EMAIL_PROVIDER: 'brevo',
      EMAIL_FROM: 'Tomato <no-reply@tomato.example.com>',
      SMTP_SECURE: false,
      BREVO_API_KEY: 'synthetic-key',
    });
    expect(brevoProvider.provider).toBe('brevo');
  });

  it('buildPasswordResetLinkEmail escape displayName, chỉ chấp nhận URL http/https và gắn rel=noreferrer', () => {
    const rendered = buildPasswordResetLinkEmail({
      displayName: '<img src=x onerror=alert(1)>',
      resetUrl: 'https://tomato.example.com/reset-password?token=abc123token',
      expiresInMinutes: 15,
    });

    expect(rendered.subject).toContain('đặt lại mật khẩu');
    expect(rendered.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(rendered.html).not.toContain('<img src=x');
    expect(rendered.html).toContain('https://tomato.example.com/reset-password?token=abc123token');
    expect(rendered.html).toContain('rel="noreferrer"');
    expect(rendered.html).toContain('15 phút');
    expect(rendered.text).toContain('https://tomato.example.com/reset-password?token=abc123token');
    expect(rendered.text).toContain('15 phút');

    const unsafe = buildPasswordResetLinkEmail({
      displayName: 'Minh Anh',
      resetUrl: 'javascript:alert(1)',
      expiresInMinutes: 15,
    });
    expect(unsafe.html).not.toContain('javascript:');
    expect(unsafe.text).not.toContain('javascript:');
  });

  it('buildPasswordResetAlertEmail & buildPasswordChangedAlertEmail hiển thị thời gian, IP, thiết bị đã escape', () => {
    const occurredAt = new Date('2026-11-22T10:30:00.000Z');
    const resetAlert = buildPasswordResetAlertEmail({
      displayName: 'Minh <Anh>',
      occurredAt,
      ipAddress: '203.0.113.88',
      deviceInfo: 'Chrome 130 / <Windows>',
      appUrl: 'https://tomato.example.com',
    });

    expect(resetAlert.subject).toContain('đặt lại');
    expect(resetAlert.html).toContain('Minh &lt;Anh&gt;');
    expect(resetAlert.html).toContain('203.0.113.88');
    expect(resetAlert.html).toContain('Chrome 130 / &lt;Windows&gt;');
    expect(resetAlert.html).toContain('https://tomato.example.com/forgot-password');
    expect(resetAlert.text).toContain('203.0.113.88');
    expect(resetAlert.text).toContain('Chrome 130 / <Windows>');

    const changedAlert = buildPasswordChangedAlertEmail({
      displayName: 'Minh Anh',
      occurredAt,
      ipAddress: null,
      deviceInfo: 'Safari 18 / macOS',
      appUrl: 'javascript:alert(1)',
    });

    expect(changedAlert.subject).toContain('thay đổi');
    expect(changedAlert.html).toContain('Không xác định');
    expect(changedAlert.html).toContain('Safari 18 / macOS');
    expect(changedAlert.html).not.toContain('javascript:');
    expect(changedAlert.text).toContain('Không xác định');
  });

  it('buildPasswordChangeOtpEmail không lộ mã OTP trong subject nhưng hiển thị rõ OTP & hạn 10 phút trong nội dung', () => {
    const rendered = buildPasswordChangeOtpEmail({
      displayName: '<b>User</b>',
      otpCode: '654321',
      expiresInMinutes: 10,
    });

    expect(rendered.subject).not.toContain('654321');
    expect(rendered.html).toContain('654321');
    expect(rendered.html).toContain('10 phút');
    expect(rendered.html).toContain('&lt;b&gt;User&lt;/b&gt;');
    expect(rendered.text).toContain('654321');
    expect(rendered.text).toContain('10 phút');
  });
});
