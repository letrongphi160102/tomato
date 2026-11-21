/**
 * Bộ từ điển thông báo Tiếng Việt tập trung cho phân hệ Auth (Mục 2.2 — chuẩn bị nền tảng i18n P1).
 * Đảm bảo đồng nhất tuyệt đối các chuỗi chống lộ tồn tại tài khoản (Account Enumeration).
 */
export const AUTH_MESSAGES = Object.freeze({
  // Phản hồi chung chống User Enumeration
  registerAccepted:
    'Nếu email hợp lệ và chưa được đăng ký, mã xác minh gồm 6 chữ số đã được gửi tới hộp thư của bạn.',
  resendAccepted:
    'Nếu tài khoản đang chờ xác minh, mã xác minh mới đã được gửi tới hộp thư của bạn.',
  emailVerified: 'Xác minh email thành công! Tài khoản TOMATO của bạn đã được kích hoạt.',

  // Validation lỗi đầu vào
  invalidJsonBody: 'Dữ liệu gửi lên không phải định dạng JSON hợp lệ.',
  payloadTooLarge: 'Kích thước yêu cầu vượt quá giới hạn cho phép.',
  validationFailed: 'Thông tin nhập vào chưa hợp lệ. Vui lòng kiểm tra lại các trường bên dưới.',
  emailRequired: 'Vui lòng nhập địa chỉ email.',
  emailInvalid: 'Địa chỉ email không đúng định dạng.',
  emailTooLong: 'Địa chỉ email không được vượt quá 254 ký tự.',
  displayNameRequired: 'Vui lòng nhập tên hiển thị.',
  displayNameTooShort: 'Tên hiển thị phải có ít nhất 2 ký tự.',
  displayNameTooLong: 'Tên hiển thị không được vượt quá 50 ký tự.',
  displayNameInvalidChars: 'Tên hiển thị chứa ký tự điều khiển không hợp lệ.',
  passwordRequired: 'Vui lòng nhập mật khẩu.',
  passwordTooShort: 'Mật khẩu phải có ít nhất 12 ký tự.',
  passwordTooLong: 'Mật khẩu không được vượt quá 128 ký tự.',
  passwordMatchesEmail: 'Mật khẩu không được trùng hoặc chứa địa chỉ email của bạn.',
  passwordMatchesDisplayName: 'Mật khẩu không được trùng với tên hiển thị của bạn.',
  passwordTooCommon:
    'Mật khẩu này quá phổ biến hoặc dễ đoán. Vui lòng chọn cụm mật khẩu an toàn hơn.',
  dateOfBirthRequired: 'Vui lòng chọn ngày sinh.',
  dateOfBirthInvalid: 'Ngày sinh không hợp lệ (định dạng YYYY-MM-DD).',
  dateOfBirthUnderage: 'Bạn phải đủ từ 13 tuổi trở lên để đăng ký tài khoản TOMATO.',
  dateOfBirthOutOfRange: 'Ngày sinh nằm ngoài phạm vi hợp lệ.',
  termsRequired: 'Bạn cần đồng ý với Điều khoản sử dụng và Chính sách quyền riêng tư để tiếp tục.',
  captchaRequired: 'Vui lòng hoàn thành bước xác thực bảo mật Cloudflare Turnstile.',
  captchaInvalid: 'Xác thực chống bot không hợp lệ hoặc đã hết hạn. Vui lòng thử lại.',
  otpFormatInvalid: 'Mã xác minh phải gồm đúng 6 chữ số.',

  // Lỗi xác minh OTP
  otpInvalidOrExpired: 'Mã xác minh không hợp lệ hoặc đã hết hạn.',
  otpExpired: 'Mã xác minh đã hết hạn. Vui lòng yêu cầu gửi lại mã mới.',
  otpRevokedMaxAttempts:
    'Bạn đã nhập sai mã xác minh 5 lần. Mã hiện tại đã bị hủy, vui lòng yêu cầu gửi mã mới.',
  otpIncorrectWithRemaining: (remaining: number) =>
    `Mã xác minh không chính xác. Bạn còn ${remaining} lần thử trước khi mã bị hủy.`,

  // Rate limit & Hệ thống
  rateLimited: (retryAfterSeconds: number) =>
    `Bạn thao tác quá nhanh. Vui lòng thử lại sau ${retryAfterSeconds} giây.`,
  resendCooldown: (retryAfterSeconds: number) =>
    `Vui lòng chờ ${retryAfterSeconds} giây trước khi yêu cầu gửi lại mã mới.`,
  emailDeliveryUnavailable: 'Hệ thống gửi email đang tạm gián đoạn. Vui lòng thử lại sau ít phút.',
  internalError: 'Đã có lỗi hệ thống xảy ra. Vui lòng thử lại sau.',
});
