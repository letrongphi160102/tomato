import type { Transporter } from 'nodemailer';
import { describe, expect, it, vi } from 'vitest';

import {
  BREVO_SMTP_EMAIL_ENDPOINT,
  BrevoEmailAdapter,
  EmailDeliveryError,
  GmailSmtpAdapter,
  buildAccountLockedAlertEmail,
  parseEmailSenderHeader,
} from '@/core/email';

describe('Unit M5: GmailSmtpAdapter, BrevoEmailAdapter & Account Locked Alert Email', () => {
  it('GmailSmtpAdapter gửi email qua transporter và bọc lỗi thành EmailDeliveryError không lộ nội dung nhạy cảm', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: 'gmail-msg-1' });
    const verify = vi.fn().mockResolvedValue(true);
    const close = vi.fn();

    const adapter = new GmailSmtpAdapter({
      user: 'tomato.demo@gmail.com',
      pass: 'synthetic-app-password-16ch',
      from: 'Tomato <tomato.demo@gmail.com>',
      transporter: { sendMail, verify, close } as unknown as Transporter,
    });

    expect(adapter.provider).toBe('gmail');

    await adapter.send({
      to: 'recipient@example.com',
      subject: '[TOMATO] Mã xác minh: 123456',
      html: '<p>123456</p>',
      text: '123456',
    });

    expect(sendMail).toHaveBeenCalledWith({
      from: 'Tomato <tomato.demo@gmail.com>',
      to: 'recipient@example.com',
      subject: '[TOMATO] Mã xác minh: 123456',
      html: '<p>123456</p>',
      text: '123456',
    });
    expect(await adapter.verify()).toBe(true);
    await adapter.close();
    expect(close).toHaveBeenCalledTimes(1);

    sendMail.mockRejectedValueOnce(Object.assign(new Error('Invalid login'), { code: 'EAUTH' }));
    await expect(
      adapter.send({
        to: 'recipient@example.com',
        subject: 'OTP 777666',
        html: '<p>777666</p>',
        text: '777666',
      }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof EmailDeliveryError &&
        error.provider === 'gmail' &&
        !error.message.includes('777666') &&
        !error.message.includes('synthetic-app-password')
      );
    });
  });

  it('parseEmailSenderHeader phân tích đúng cả dạng có tên lẫn email thuần và chặn chuỗi hỏng', () => {
    expect(parseEmailSenderHeader('Tomato Security <no-reply@tomato.example.com>')).toEqual({
      name: 'Tomato Security',
      email: 'no-reply@tomato.example.com',
    });
    expect(parseEmailSenderHeader('"Tomato" <hello@tomato.example.com>')).toEqual({
      name: 'Tomato',
      email: 'hello@tomato.example.com',
    });
    expect(parseEmailSenderHeader('plain@tomato.example.com')).toEqual({
      email: 'plain@tomato.example.com',
    });
    expect(() => parseEmailSenderHeader('not-an-email')).toThrow();
  });

  it('BrevoEmailAdapter gọi đúng Brevo REST API v3 và bọc lỗi HTTP/mạng thành EmailDeliveryError an toàn', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messageId: '<brevo-1@smtp-relay.mailin.fr>' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const adapter = new BrevoEmailAdapter({
      apiKey: 'xkeysib-synthetic-brevo-api-key',
      from: 'Tomato <no-reply@tomato.example.com>',
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });

    expect(adapter.provider).toBe('brevo');

    await adapter.send({
      to: 'member@example.com',
      subject: '[TOMATO] Chào mừng',
      html: '<p>Xin chào</p>',
      text: 'Xin chào',
    });

    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fakeFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(BREVO_SMTP_EMAIL_ENDPOINT);
    expect(calledInit.method).toBe('POST');
    expect(calledInit.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      'api-key': 'xkeysib-synthetic-brevo-api-key',
    });
    expect(JSON.parse(String(calledInit.body))).toEqual({
      sender: { name: 'Tomato', email: 'no-reply@tomato.example.com' },
      to: [{ email: 'member@example.com' }],
      subject: '[TOMATO] Chào mừng',
      htmlContent: '<p>Xin chào</p>',
      textContent: 'Xin chào',
    });

    // HTTP 401 từ Brevo -> ném EmailDeliveryError, tuyệt đối không lộ API key hay OTP.
    fakeFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Key not found' }), { status: 401 }),
    );
    await expect(
      adapter.send({
        to: 'member@example.com',
        subject: 'OTP 554433',
        html: '<p>554433</p>',
        text: '554433',
      }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof EmailDeliveryError &&
        error.provider === 'brevo' &&
        !error.message.includes('xkeysib-synthetic-brevo-api-key') &&
        !error.message.includes('554433')
      );
    });

    // Lỗi mạng -> ném EmailDeliveryError.
    fakeFetch.mockRejectedValueOnce(new Error('Network down'));
    await expect(
      adapter.send({
        to: 'member@example.com',
        subject: 'Test',
        html: '<p>Hi</p>',
        text: 'Hi',
      }),
    ).rejects.toBeInstanceOf(EmailDeliveryError);
  });

  it('buildAccountLockedAlertEmail escape HTML, hiển thị đủ số lần sai, thời gian, IP, thiết bị và link mở khóa', () => {
    const rendered = buildAccountLockedAlertEmail({
      displayName: '<b>Nguyễn An</b>',
      occurredAt: new Date('2026-11-23T02:15:00.000Z'),
      ipAddress: '203.0.113.50',
      deviceInfo: 'Chrome 130 / <Windows>',
      failedAttempts: 50,
      appUrl: 'https://tomato.example.com',
    });

    expect(rendered.subject).toContain('tạm khóa');
    expect(rendered.html).toContain('&lt;b&gt;Nguyễn An&lt;/b&gt;');
    expect(rendered.html).not.toContain('<b>Nguyễn An</b>');
    expect(rendered.html).toContain('50 lần');
    expect(rendered.html).toContain('203.0.113.50');
    expect(rendered.html).toContain('Chrome 130 / &lt;Windows&gt;');
    expect(rendered.html).toContain('https://tomato.example.com/forgot-password');
    expect(rendered.html).toContain('rel="noreferrer"');
    expect(rendered.text).toContain('50 lần');
    expect(rendered.text).toContain('203.0.113.50');
    expect(rendered.text).toContain('https://tomato.example.com/forgot-password');

    const unsafe = buildAccountLockedAlertEmail({
      displayName: 'An',
      occurredAt: new Date('2026-11-23T02:15:00.000Z'),
      ipAddress: null,
      deviceInfo: 'Unknown',
      failedAttempts: 50,
      appUrl: 'javascript:alert(1)',
    });
    expect(unsafe.html).not.toContain('javascript:');
    expect(unsafe.html).toContain('Không xác định');
    expect(unsafe.text).not.toContain('javascript:');
  });
});
