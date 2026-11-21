import type { Transporter } from 'nodemailer';
import { describe, expect, it, vi } from 'vitest';

import {
  EmailDeliveryError,
  SmtpEmailAdapter,
  buildDuplicateRegistrationEmail,
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

  it('createEmailProvider tạo SmtpEmailAdapter khi EMAIL_PROVIDER=smtp và báo lỗi với provider chưa mở ở M2', () => {
    const smtpProvider = createEmailProvider({
      EMAIL_PROVIDER: 'smtp',
      EMAIL_FROM: 'Tomato <no-reply@tomato.local>',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: 1025,
      SMTP_SECURE: false,
    });
    expect(smtpProvider.provider).toBe('smtp');

    expect(() =>
      createEmailProvider({
        EMAIL_PROVIDER: 'brevo',
        EMAIL_FROM: 'Tomato <no-reply@tomato.local>',
        SMTP_SECURE: false,
        BREVO_API_KEY: 'synthetic-key',
      }),
    ).toThrow(/M2/);
  });
});
