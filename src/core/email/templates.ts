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

export interface PasswordResetLinkEmailData {
  readonly displayName: string;
  readonly resetUrl: string;
  readonly expiresInMinutes: number;
}

export interface PasswordSecurityAlertEmailData {
  readonly displayName: string;
  readonly occurredAt: Date;
  readonly ipAddress: string | null;
  readonly deviceInfo: string;
  readonly appUrl: string;
}

export interface PasswordChangeOtpEmailData {
  readonly displayName: string;
  readonly otpCode: string;
  readonly expiresInMinutes: number;
}

export interface AccountLockedAlertEmailData {
  readonly displayName: string;
  readonly occurredAt: Date;
  readonly ipAddress: string | null;
  readonly deviceInfo: string;
  readonly failedAttempts: number;
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

function formatSecurityTimestamp(occurredAt: Date): string {
  if (Number.isNaN(occurredAt.getTime())) {
    return 'Không xác định';
  }
  try {
    const formatted = new Intl.DateTimeFormat('vi-VN', {
      dateStyle: 'medium',
      timeStyle: 'medium',
      timeZone: 'Asia/Ho_Chi_Minh',
    }).format(occurredAt);
    return `${formatted} (GMT+7)`;
  } catch {
    return occurredAt.toISOString();
  }
}

function buildSafeAppSubpathUrl(appUrl: string, pathname: string): string {
  const safeBase = sanitizeSafeHttpUrl(appUrl);
  if (!safeBase) {
    return '';
  }
  try {
    return new URL(pathname, safeBase).toString();
  } catch {
    return safeBase;
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
  // Không đưa mã OTP nhạy cảm vào dòng Subject để tránh lưu trong log MTA/Brevo và lộ trên màn hình khóa.
  const subject = '[TOMATO] Mã xác minh email tài khoản của bạn';

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

/**
 * Mẫu email gửi liên kết đặt lại mật khẩu dùng một lần (hiệu lực 15 phút).
 */
export function buildPasswordResetLinkEmail(
  data: PasswordResetLinkEmailData,
): RenderedEmailTemplate {
  const safeName = escapeHtml(data.displayName);
  const safeResetUrl = sanitizeSafeHttpUrl(data.resetUrl);
  const escapedResetUrl = escapeHtml(safeResetUrl);
  const subject = '[TOMATO] Yêu cầu đặt lại mật khẩu tài khoản của bạn';

  const actionBlock = escapedResetUrl
    ? `<div style="margin:0 0 20px;text-align:center;">
         <a href="${escapedResetUrl}" rel="noreferrer" style="display:inline-block;padding:12px 24px;background-color:#dc2626;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:8px;">Đặt lại mật khẩu</a>
       </div>
       <p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#525252;word-break:break-all;">
         Nếu nút phía trên không hoạt động, bạn có thể sao chép và dán liên kết sau vào trình duyệt:<br />
         <a href="${escapedResetUrl}" rel="noreferrer" style="color:#dc2626;text-decoration:underline;">${escapedResetUrl}</a>
       </p>`
    : '';

  const bodyHtml = `
    <h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;color:#171717;">Đặt lại mật khẩu tài khoản</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#404040;">
      Xin chào <strong>${safeName}</strong>,
    </p>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#404040;">
      Chúng tôi nhận được yêu cầu đặt lại mật khẩu cho tài khoản TOMATO của bạn. Nhấn vào nút bên dưới để tạo mật khẩu mới:
    </p>
    ${actionBlock}
    <p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#525252;">
      Liên kết này chỉ sử dụng được <strong>một lần duy nhất</strong> và sẽ hết hạn sau <strong>${data.expiresInMinutes} phút</strong>. Mọi liên kết đặt lại mật khẩu trước đó đã được vô hiệu hóa.
    </p>
    <p style="margin:0;font-size:13px;line-height:1.6;color:#737373;">
      <strong>Lưu ý bảo mật:</strong> Tuyệt đối không chia sẻ liên kết này cho bất kỳ ai. Nếu bạn không yêu cầu đặt lại mật khẩu, hãy bỏ qua email này — mật khẩu hiện tại của bạn vẫn giữ nguyên.
    </p>
  `;

  const text = [
    `Xin chào ${data.displayName},`,
    '',
    'Chúng tôi nhận được yêu cầu đặt lại mật khẩu cho tài khoản TOMATO của bạn.',
    ...(safeResetUrl ? ['', `Liên kết đặt lại mật khẩu: ${safeResetUrl}`] : []),
    '',
    `Liên kết chỉ dùng được một lần và có hiệu lực trong ${data.expiresInMinutes} phút. Mọi liên kết trước đó đã bị vô hiệu hóa.`,
    'Lưu ý bảo mật: Tuyệt đối không chia sẻ liên kết này. Nếu bạn không yêu cầu đặt lại mật khẩu, hãy bỏ qua email này.',
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
 * Mẫu email cảnh báo bảo mật gửi ngay sau khi mật khẩu được đặt lại thành công (kèm thời gian, IP, thiết bị).
 */
export function buildPasswordResetAlertEmail(
  data: PasswordSecurityAlertEmailData,
): RenderedEmailTemplate {
  const safeName = escapeHtml(data.displayName);
  const formattedTime = formatSecurityTimestamp(data.occurredAt);
  const safeTime = escapeHtml(formattedTime);
  const displayIp = data.ipAddress ?? 'Không xác định';
  const safeIp = escapeHtml(displayIp);
  const safeDevice = escapeHtml(data.deviceInfo);
  const recoveryUrl = buildSafeAppSubpathUrl(data.appUrl, '/forgot-password');
  const escapedRecoveryUrl = escapeHtml(recoveryUrl);
  const subject = '[TOMATO] Cảnh báo bảo mật: Mật khẩu của bạn vừa được đặt lại';

  const recoveryBlock = escapedRecoveryUrl
    ? `<p style="margin:0;font-size:13px;line-height:1.6;color:#737373;">
         Nếu bạn <strong>không</strong> thực hiện thao tác này, hãy khôi phục tài khoản ngay lập tức tại:
         <a href="${escapedRecoveryUrl}" style="color:#dc2626;text-decoration:underline;">${escapedRecoveryUrl}</a>
       </p>`
    : `<p style="margin:0;font-size:13px;line-height:1.6;color:#737373;">
         Nếu bạn <strong>không</strong> thực hiện thao tác này, hãy sử dụng tính năng Quên mật khẩu ngay lập tức để bảo vệ tài khoản.
       </p>`;

  const bodyHtml = `
    <h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;color:#171717;">Mật khẩu tài khoản vừa được đặt lại</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#404040;">
      Xin chào <strong>${safeName}</strong>,
    </p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#404040;">
      Mật khẩu tài khoản TOMATO của bạn vừa được đặt lại thành công. Để bảo vệ an toàn, hệ thống đã <strong>đăng xuất toàn bộ phiên đăng nhập cũ trên mọi thiết bị</strong>.
    </p>
    <div style="margin:0 0 18px;padding:14px 16px;background-color:#fafafa;border:1px solid #e5e5e5;border-radius:8px;font-size:14px;line-height:1.7;color:#262626;">
      <div><strong>Thời gian:</strong> ${safeTime}</div>
      <div><strong>Địa chỉ IP:</strong> ${safeIp}</div>
      <div><strong>Thiết bị:</strong> ${safeDevice}</div>
    </div>
    ${recoveryBlock}
  `;

  const text = [
    `Xin chào ${data.displayName},`,
    '',
    'Mật khẩu tài khoản TOMATO của bạn vừa được đặt lại thành công.',
    'Để bảo vệ an toàn, toàn bộ phiên đăng nhập cũ trên mọi thiết bị đã bị thu hồi.',
    '',
    `Thời gian: ${formattedTime}`,
    `Địa chỉ IP: ${displayIp}`,
    `Thiết bị: ${data.deviceInfo}`,
    '',
    ...(recoveryUrl
      ? [`Nếu bạn không thực hiện thao tác này, hãy đặt lại mật khẩu ngay tại: ${recoveryUrl}`]
      : ['Nếu bạn không thực hiện thao tác này, hãy dùng tính năng Quên mật khẩu ngay lập tức.']),
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
 * Mẫu email gửi mã OTP 6 chữ số xác nhận thao tác đổi mật khẩu khi đã đăng nhập (hiệu lực 10 phút).
 */
export function buildPasswordChangeOtpEmail(
  data: PasswordChangeOtpEmailData,
): RenderedEmailTemplate {
  const safeName = escapeHtml(data.displayName);
  const safeOtp = escapeHtml(data.otpCode);
  // Không đưa mã OTP nhạy cảm vào dòng Subject để tránh lộ trên màn hình khóa / thông báo đẩy.
  const subject = '[TOMATO] Mã xác nhận đổi mật khẩu tài khoản của bạn';

  const bodyHtml = `
    <h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;color:#171717;">Xác nhận đổi mật khẩu</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#404040;">
      Xin chào <strong>${safeName}</strong>,
    </p>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#404040;">
      Bạn vừa yêu cầu đổi mật khẩu tài khoản TOMATO. Vui lòng nhập mã xác nhận gồm 6 chữ số dưới đây để hoàn tất thay đổi:
    </p>
    <div style="margin:0 0 20px;padding:18px 20px;background-color:#fef2f2;border:1px solid #fecaca;border-radius:10px;text-align:center;">
      <span style="display:inline-block;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:32px;font-weight:700;letter-spacing:0.35em;color:#b91c1c;">${safeOtp}</span>
    </div>
    <p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#525252;">
      Mã xác nhận này có hiệu lực trong <strong>${data.expiresInMinutes} phút</strong> và sẽ bị hủy ngay nếu nhập sai quá 5 lần.
    </p>
    <p style="margin:0;font-size:13px;line-height:1.6;color:#737373;">
      <strong>Lưu ý bảo mật:</strong> Tuyệt đối không chia sẻ mã OTP này cho bất kỳ ai. Nếu bạn không yêu cầu đổi mật khẩu, hãy kiểm tra danh sách thiết bị đang đăng nhập và đổi mật khẩu ngay lập tức.
    </p>
  `;

  const text = [
    `Xin chào ${data.displayName},`,
    '',
    'Bạn vừa yêu cầu đổi mật khẩu tài khoản TOMATO.',
    `Mã xác nhận đổi mật khẩu 6 chữ số của bạn là: ${data.otpCode}`,
    '',
    `Mã có hiệu lực trong ${data.expiresInMinutes} phút và sẽ bị hủy ngay nếu nhập sai quá 5 lần.`,
    'Lưu ý bảo mật: Tuyệt đối không chia sẻ mã này cho bất kỳ ai. Nếu bạn không thực hiện yêu cầu này, hãy kiểm tra ngay các thiết bị đang đăng nhập.',
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
 * Mẫu email thông báo bảo mật sau khi người dùng đổi mật khẩu thành công (kèm thời gian, IP, thiết bị).
 */
export function buildPasswordChangedAlertEmail(
  data: PasswordSecurityAlertEmailData,
): RenderedEmailTemplate {
  const safeName = escapeHtml(data.displayName);
  const formattedTime = formatSecurityTimestamp(data.occurredAt);
  const safeTime = escapeHtml(formattedTime);
  const displayIp = data.ipAddress ?? 'Không xác định';
  const safeIp = escapeHtml(displayIp);
  const safeDevice = escapeHtml(data.deviceInfo);
  const recoveryUrl = buildSafeAppSubpathUrl(data.appUrl, '/forgot-password');
  const escapedRecoveryUrl = escapeHtml(recoveryUrl);
  const subject = '[TOMATO] Thông báo bảo mật: Mật khẩu của bạn vừa được thay đổi';

  const recoveryBlock = escapedRecoveryUrl
    ? `<p style="margin:0;font-size:13px;line-height:1.6;color:#737373;">
         Nếu bạn <strong>không</strong> thực hiện thay đổi này, hãy đặt lại mật khẩu ngay lập tức tại:
         <a href="${escapedRecoveryUrl}" style="color:#dc2626;text-decoration:underline;">${escapedRecoveryUrl}</a>
       </p>`
    : `<p style="margin:0;font-size:13px;line-height:1.6;color:#737373;">
         Nếu bạn <strong>không</strong> thực hiện thay đổi này, hãy sử dụng tính năng Quên mật khẩu ngay lập tức để lấy lại quyền kiểm soát tài khoản.
       </p>`;

  const bodyHtml = `
    <h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;color:#171717;">Mật khẩu tài khoản vừa được thay đổi</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#404040;">
      Xin chào <strong>${safeName}</strong>,
    </p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#404040;">
      Mật khẩu tài khoản TOMATO của bạn vừa được cập nhật thành công. Toàn bộ phiên đăng nhập trên các thiết bị khác đã được thu hồi tự động và phiên trên thiết bị hiện tại đã được làm mới.
    </p>
    <div style="margin:0 0 18px;padding:14px 16px;background-color:#fafafa;border:1px solid #e5e5e5;border-radius:8px;font-size:14px;line-height:1.7;color:#262626;">
      <div><strong>Thời gian:</strong> ${safeTime}</div>
      <div><strong>Địa chỉ IP:</strong> ${safeIp}</div>
      <div><strong>Thiết bị:</strong> ${safeDevice}</div>
    </div>
    ${recoveryBlock}
  `;

  const text = [
    `Xin chào ${data.displayName},`,
    '',
    'Mật khẩu tài khoản TOMATO của bạn vừa được thay đổi thành công.',
    'Toàn bộ phiên đăng nhập trên các thiết bị khác đã bị đăng xuất và phiên hiện tại đã được làm mới.',
    '',
    `Thời gian: ${formattedTime}`,
    `Địa chỉ IP: ${displayIp}`,
    `Thiết bị: ${data.deviceInfo}`,
    '',
    ...(recoveryUrl
      ? [`Nếu bạn không thực hiện thay đổi này, hãy đặt lại mật khẩu ngay tại: ${recoveryUrl}`]
      : [
          'Nếu bạn không thực hiện thay đổi này, hãy sử dụng tính năng Quên mật khẩu ngay lập tức.',
        ]),
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
 * Mẫu email cảnh báo bảo mật khi tài khoản bị tự động tạm khóa do chạm ngưỡng 50 lần
 * đăng nhập sai liên tiếp (Mục 4.2), kèm thời gian, IP, thiết bị và hướng dẫn mở khóa qua Quên mật khẩu.
 */
export function buildAccountLockedAlertEmail(
  data: AccountLockedAlertEmailData,
): RenderedEmailTemplate {
  const safeName = escapeHtml(data.displayName);
  const formattedTime = formatSecurityTimestamp(data.occurredAt);
  const safeTime = escapeHtml(formattedTime);
  const displayIp = data.ipAddress ?? 'Không xác định';
  const safeIp = escapeHtml(displayIp);
  const safeDevice = escapeHtml(data.deviceInfo);
  const recoveryUrl = buildSafeAppSubpathUrl(data.appUrl, '/forgot-password');
  const escapedRecoveryUrl = escapeHtml(recoveryUrl);
  const subject = '[TOMATO] Cảnh báo bảo mật: Tài khoản của bạn đã được tạm khóa';

  const unlockBlock = escapedRecoveryUrl
    ? `<div style="margin:0 0 20px;text-align:center;">
         <a href="${escapedRecoveryUrl}" rel="noreferrer" style="display:inline-block;padding:12px 24px;background-color:#dc2626;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:8px;">Mở khóa tài khoản qua Quên mật khẩu</a>
       </div>
       <p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#525252;word-break:break-all;">
         Hoặc mở liên kết sau trên trình duyệt để đặt lại mật khẩu và mở khóa tài khoản:<br />
         <a href="${escapedRecoveryUrl}" rel="noreferrer" style="color:#dc2626;text-decoration:underline;">${escapedRecoveryUrl}</a>
       </p>`
    : `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#404040;">
         Để mở khóa tài khoản, vui lòng truy cập trang <strong>Quên mật khẩu</strong> trên TOMATO và đặt lại mật khẩu mới qua email.
       </p>`;

  const bodyHtml = `
    <h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;color:#171717;">Tài khoản của bạn vừa được tạm khóa bảo vệ</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#404040;">
      Xin chào <strong>${safeName}</strong>,
    </p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#404040;">
      Hệ thống bảo mật TOMATO phát hiện <strong>${data.failedAttempts} lần đăng nhập sai mật khẩu liên tiếp</strong> vào tài khoản của bạn. Để ngăn chặn nguy cơ bị chiếm đoạt, tài khoản đã được tự động chuyển sang trạng thái <strong>tạm khóa</strong>.
    </p>
    <div style="margin:0 0 18px;padding:14px 16px;background-color:#fef2f2;border:1px solid #fecaca;border-radius:8px;font-size:14px;line-height:1.7;color:#262626;">
      <div><strong>Thời gian khóa:</strong> ${safeTime}</div>
      <div><strong>Địa chỉ IP gần nhất:</strong> ${safeIp}</div>
      <div><strong>Thiết bị:</strong> ${safeDevice}</div>
    </div>
    ${unlockBlock}
    <p style="margin:0;font-size:13px;line-height:1.6;color:#737373;">
      <strong>Lưu ý bảo mật:</strong> Sau khi đặt lại mật khẩu mới, toàn bộ phiên đăng nhập cũ trên mọi thiết bị sẽ tự động bị đăng xuất. Hãy sử dụng cụm mật khẩu mạnh (12–128 ký tự) không trùng với bất kỳ dịch vụ nào khác.
    </p>
  `;

  const text = [
    `Xin chào ${data.displayName},`,
    '',
    `Hệ thống bảo mật TOMATO phát hiện ${data.failedAttempts} lần đăng nhập sai mật khẩu liên tiếp vào tài khoản của bạn.`,
    'Để bảo vệ an toàn, tài khoản đã được tự động chuyển sang trạng thái tạm khóa.',
    '',
    `Thời gian khóa: ${formattedTime}`,
    `Địa chỉ IP gần nhất: ${displayIp}`,
    `Thiết bị: ${data.deviceInfo}`,
    '',
    ...(recoveryUrl
      ? [`Để mở khóa tài khoản, vui lòng đặt lại mật khẩu tại: ${recoveryUrl}`]
      : ['Để mở khóa tài khoản, vui lòng sử dụng tính năng Quên mật khẩu trên TOMATO.']),
    '',
    'Lưu ý: Khi đặt lại mật khẩu thành công, toàn bộ phiên đăng nhập cũ sẽ bị đăng xuất tự động.',
    '',
    '-- Đội ngũ bảo mật TOMATO',
  ].join('\n');

  return {
    subject,
    html: wrapEmailLayout(subject, bodyHtml),
    text,
  };
}
