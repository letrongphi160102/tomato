export interface RenderedEmailTemplate {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface VerificationOtpEmailData {
  readonly displayName: string;
  readonly otpCode: string;
  readonly expiresInMinutes: number;
}

export interface DuplicateRegistrationEmailData {
  readonly displayName: string;
  readonly appUrl: string;
}

const HTML_ESCAPE_MAP: Readonly<Record<string, string>> = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

/**
 * Escape mọi dữ liệu đầu vào người dùng trước khi nhúng vào HTML email
 * để ngăn chặn HTML Injection và giả mạo liên kết/giao diện trong hộp thư.
 */
export function escapeHtml(raw: string): string {
  return raw.replace(/[&<>"']/g, (char) => HTML_ESCAPE_MAP[char] ?? char);
}

function sanitizeSafeHttpUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
    return '';
  } catch {
    return '';
  }
}

function wrapEmailLayout(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="vi">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f8f9fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#171717;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background-color:#ffffff;border:1px solid #e5e5e5;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="padding:24px 28px;border-bottom:1px solid #f0f0f0;">
                <span style="font-size:20px;font-weight:700;letter-spacing:-0.02em;color:#dc2626;">TOMATO</span>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:18px 28px;background-color:#fafafa;border-top:1px solid #f0f0f0;font-size:12px;line-height:1.5;color:#737373;">
                Email này được gửi tự động từ hệ thống bảo mật TOMATO. Vui lòng không trả lời trực tiếp email này.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/**
 * Mẫu email gửi mã OTP 6 chữ số xác minh quyền sở hữu email khi đăng ký tài khoản.
 */
export function buildVerificationOtpEmail(data: VerificationOtpEmailData): RenderedEmailTemplate {
  const safeName = escapeHtml(data.displayName);
  const safeOtp = escapeHtml(data.otpCode);
  const subject = `[TOMATO] Mã xác minh email của bạn: ${data.otpCode}`;

  const bodyHtml = `
    <h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;color:#171717;">Xác minh địa chỉ email của bạn</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#404040;">
      Xin chào <strong>${safeName}</strong>,
    </p>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#404040;">
      Cảm ơn bạn đã đăng ký tài khoản TOMATO. Vui lòng nhập mã xác minh gồm 6 chữ số dưới đây để hoàn tất kích hoạt tài khoản:
    </p>
    <div style="margin:0 0 20px;padding:18px 20px;background-color:#fef2f2;border:1px solid #fecaca;border-radius:10px;text-align:center;">
      <span style="display:inline-block;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:32px;font-weight:700;letter-spacing:0.35em;color:#b91c1c;">${safeOtp}</span>
    </div>
    <p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#525252;">
      Mã xác minh này có hiệu lực trong <strong>${data.expiresInMinutes} phút</strong> và sẽ bị hủy ngay nếu nhập sai quá 5 lần.
    </p>
    <p style="margin:0;font-size:13px;line-height:1.6;color:#737373;">
      <strong>Lưu ý bảo mật:</strong> Tuyệt đối không chia sẻ mã OTP này cho bất kỳ ai, kể cả người tự xưng là nhân viên TOMATO. Nếu bạn không thực hiện đăng ký này, hãy bỏ qua email.
    </p>
  `;

  const text = [
    `Xin chào ${data.displayName},`,
    '',
    'Cảm ơn bạn đã đăng ký tài khoản TOMATO.',
    `Mã xác minh email 6 chữ số của bạn là: ${data.otpCode}`,
    '',
    `Mã có hiệu lực trong ${data.expiresInMinutes} phút và sẽ bị hủy ngay nếu nhập sai quá 5 lần.`,
    'Lưu ý bảo mật: Tuyệt đối không chia sẻ mã này cho bất kỳ ai. Nếu bạn không thực hiện yêu cầu này, hãy bỏ qua email.',
    '',
    '-- Đội ngũ bảo mật TOMATO',
  ].join('\n');

  return {
    subject,
    html: wrapEmailLayout(subject, bodyHtml),
    text,
  };
}

/**
 * Mẫu email nhắc nhở gửi riêng cho chủ tài khoản đã tồn tại khi có người cố đăng ký trùng email,
 * nhằm duy trì phản hồi trung tính chống dò tìm tài khoản (Account Enumeration).
 */
export function buildDuplicateRegistrationEmail(
  data: DuplicateRegistrationEmailData,
): RenderedEmailTemplate {
  const safeName = escapeHtml(data.displayName);
  const safeAppUrl = sanitizeSafeHttpUrl(data.appUrl);
  const escapedUrl = escapeHtml(safeAppUrl);
  const subject = '[TOMATO] Thông báo yêu cầu đăng ký bằng địa chỉ email của bạn';

  const linkBlock = escapedUrl
    ? `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#404040;">
         Bạn có thể truy cập TOMATO tại: <a href="${escapedUrl}" style="color:#dc2626;text-decoration:underline;">${escapedUrl}</a>
       </p>`
    : '';

  const bodyHtml = `
    <h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;color:#171717;">Địa chỉ email này đã được đăng ký</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#404040;">
      Xin chào <strong>${safeName}</strong>,
    </p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#404040;">
      Chúng tôi ghi nhận vừa có một yêu cầu đăng ký tài khoản TOMATO mới sử dụng địa chỉ email của bạn.
    </p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#404040;">
      Tài khoản hiện tại của bạn vẫn <strong>hoàn toàn an toàn và không bị thay đổi</strong>. Nếu đây là bạn, hãy sử dụng tài khoản đã có để đăng nhập (hoặc khôi phục mật khẩu nếu bạn quên).
    </p>
    ${linkBlock}
    <p style="margin:0;font-size:13px;line-height:1.6;color:#737373;">
      Nếu bạn không thực hiện thao tác này, bạn có thể yên tâm bỏ qua email này.
    </p>
  `;

  const text = [
    `Xin chào ${data.displayName},`,
    '',
    'Chúng tôi ghi nhận vừa có một yêu cầu đăng ký tài khoản TOMATO mới sử dụng địa chỉ email của bạn.',
    'Tài khoản hiện tại của bạn vẫn hoàn toàn an toàn và không bị thay đổi.',
    'Nếu đây là bạn, hãy sử dụng tài khoản đã có để đăng nhập (hoặc khôi phục mật khẩu nếu bạn quên).',
    ...(safeAppUrl ? ['', `Truy cập TOMATO: ${safeAppUrl}`] : []),
    '',
    'Nếu bạn không thực hiện thao tác này, bạn có thể yên tâm bỏ qua email này.',
    '',
    '-- Đội ngũ bảo mật TOMATO',
  ].join('\n');

  return {
    subject,
    html: wrapEmailLayout(subject, bodyHtml),
    text,
  };
}
