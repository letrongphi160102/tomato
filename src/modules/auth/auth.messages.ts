/**
 * Bộ từ điển thông báo Tiếng Việt tập trung cho phân hệ Auth (Mục 2.2 — chuẩn bị nền tảng i18n P1).
 * Đảm bảo đồng nhất chuỗi thông báo lỗi đăng nhập chống lộ tài khoản qua `/login`.
 */
export const AUTH_MESSAGES = Object.freeze({
  // Đăng ký & Xác minh Email
  registerAccepted: 'Đăng ký thành công! Mã xác minh gồm 6 chữ số đã được gửi tới hộp thư của bạn.',
  emailAlreadyExists: 'Địa chỉ email này đã được đăng ký tài khoản TOMATO. Vui lòng đăng nhập.',
  usernameAlreadyExists: 'ID tài khoản này đã được sử dụng. Vui lòng chọn ID khác.',
  resendAccepted:
    'Nếu tài khoản đang chờ xác minh, mã xác minh mới đã được gửi tới hộp thư của bạn.',
  emailVerified: 'Xác minh email thành công! Tài khoản TOMATO của bạn đã được kích hoạt.',

  // Đăng nhập, Trạng thái tài khoản & Quản lý Phiên (M3)
  loginSuccess: 'Đăng nhập thành công.',
  logoutSuccess: 'Bạn đã đăng xuất khỏi thiết bị này.',
  // Thông báo duy nhất dùng chung cho cả sai email, sai mật khẩu và tài khoản đã xóa (Mục 4.2).
  invalidCredentials: 'Email hoặc mật khẩu không chính xác.',
  emailNotVerified:
    'Tài khoản của bạn chưa được xác minh email. Vui lòng nhập mã OTP hoặc yêu cầu gửi lại mã mới.',
  accountLocked:
    'Tài khoản của bạn đang bị tạm khóa để bảo vệ an toàn. Vui lòng sử dụng tính năng Quên mật khẩu để mở khóa qua email.',
  accountSuspended:
    'Tài khoản của bạn đã bị tạm đình chỉ do vi phạm chính sách sử dụng của TOMATO.',
  unauthorized: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại.',
  forbidden: 'Bạn không có quyền thực hiện thao tác này.',
  sessionNotFound: 'Không tìm thấy phiên đăng nhập được yêu cầu.',
  sessionRevoked: 'Đã đăng xuất thiết bị khỏi tài khoản của bạn.',
  allOtherSessionsRevoked: 'Đã đăng xuất khỏi tất cả các thiết bị khác.',
  allSessionsRevoked: 'Đã đăng xuất khỏi tất cả các thiết bị.',

  // Quên mật khẩu, Đặt lại mật khẩu & Đổi mật khẩu 2 bước
  forgotPasswordSent:
    'Liên kết đặt lại mật khẩu đã được gửi tới email của bạn. Vui lòng kiểm tra hộp thư trong vòng 15 phút.',
  forgotPasswordEmailNotFound: 'Không tìm thấy tài khoản TOMATO nào gắn với địa chỉ email này.',
  resetTokenInvalidOrExpired: 'Liên kết đặt lại mật khẩu không hợp lệ hoặc đã được sử dụng.',
  resetTokenExpired: 'Liên kết đặt lại mật khẩu đã hết hạn. Vui lòng yêu cầu liên kết mới.',
  passwordResetSuccess:
    'Đặt lại mật khẩu thành công! Tất cả các thiết bị cũ đã được đăng xuất. Vui lòng đăng nhập lại với mật khẩu mới.',
  changePasswordOtpSent:
    'Mã xác nhận gồm 6 chữ số đã được gửi tới email của bạn (có hiệu lực trong 10 phút).',
  changePasswordOtpVerified: 'Xác nhận email thành công. Bạn có 10 phút để cập nhật mật khẩu mới.',
  changePasswordOtpCooldown: (retryAfterSeconds: number) =>
    `Vui lòng chờ ${retryAfterSeconds} giây trước khi yêu cầu gửi lại mã xác nhận.`,
  changePasswordTicketRequired:
    'Vui lòng hoàn tất bước xác nhận qua email trước khi đặt mật khẩu mới.',
  changePasswordTicketInvalid:
    'Phiên xác nhận đổi mật khẩu không hợp lệ hoặc đã được sử dụng. Vui lòng xác nhận lại qua email.',
  changePasswordTicketExpired:
    'Phiên xác nhận đổi mật khẩu đã hết hạn. Vui lòng yêu cầu mã xác nhận mới qua email.',
  changePasswordTicketRevokedMaxAttempts:
    'Bạn đã nhập sai mật khẩu hiện tại quá số lần cho phép. Vui lòng xác nhận lại qua email.',
  currentPasswordRequired: 'Vui lòng nhập mật khẩu hiện tại.',
  currentPasswordIncorrect: 'Mật khẩu hiện tại không chính xác.',
  newPasswordSameAsCurrent: 'Mật khẩu mới không được trùng với mật khẩu hiện tại.',
  passwordChangedSuccess: 'Đổi mật khẩu thành công! Các thiết bị khác đã tự động được đăng xuất.',
  passwordChangeConcurrentConflict: 'Mật khẩu tài khoản vừa được thay đổi. Vui lòng thử lại.',

  // Validation lỗi đầu vào
  invalidJsonBody: 'Dữ liệu gửi lên không phải định dạng JSON hợp lệ.',
  payloadTooLarge: 'Kích thước yêu cầu vượt quá giới hạn cho phép.',
  validationFailed: 'Thông tin nhập vào chưa hợp lệ. Vui lòng kiểm tra lại các trường bên dưới.',
  emailRequired: 'Vui lòng nhập địa chỉ email.',
  emailInvalid: 'Địa chỉ email không đúng định dạng.',
  emailTooLong: 'Địa chỉ email không được vượt quá 254 ký tự.',
  fullNameRequired: 'Vui lòng nhập họ tên.',
  fullNameTooShort: 'Họ tên phải có ít nhất 2 ký tự.',
  fullNameTooLong: 'Họ tên không được vượt quá 50 ký tự.',
  fullNameInvalidChars: 'Họ tên chứa ký tự điều khiển không hợp lệ.',
  usernameRequired: 'Vui lòng nhập ID tài khoản.',
  usernameNoSpaces: 'ID tài khoản không được chứa khoảng trắng.',
  usernameTooShort: 'ID tài khoản phải có ít nhất 3 ký tự.',
  usernameTooLong: 'ID tài khoản không được vượt quá 30 ký tự.',
  usernameInvalidChars:
    'ID tài khoản chỉ được chứa chữ cái không dấu, chữ số, dấu chấm (.) và gạch dưới (_).',
  usernameInvalidDots:
    'ID tài khoản không được bắt đầu, kết thúc bằng dấu chấm hoặc chứa hai dấu chấm liên tiếp.',
  usernameReserved: 'ID tài khoản này được hệ thống bảo lưu. Vui lòng chọn ID khác.',
  genderRequired: 'Vui lòng chọn giới tính.',
  passwordRequired: 'Vui lòng nhập mật khẩu.',
  passwordTooShort: 'Mật khẩu phải có ít nhất 12 ký tự.',
  passwordTooLong: 'Mật khẩu không được vượt quá 128 ký tự.',
  passwordNoVietnameseDiacritics: 'Mật khẩu không được chứa dấu tiếng Việt.',
  passwordMatchesEmail: 'Mật khẩu không được trùng hoặc chứa địa chỉ email của bạn.',
  passwordMatchesFullName: 'Mật khẩu không được trùng với họ tên của bạn.',
  passwordMatchesUsername: 'Mật khẩu không được trùng với ID tài khoản của bạn.',
  passwordTooCommon:
    'Mật khẩu này quá phổ biến hoặc dễ đoán. Vui lòng chọn cụm mật khẩu an toàn hơn.',
  dateOfBirthRequired: 'Vui lòng chọn ngày sinh.',
  dateOfBirthInvalid: 'Ngày sinh không hợp lệ (định dạng YYYY-MM-DD).',
  dateOfBirthUnderage: 'Bạn phải đủ từ 13 tuổi trở lên để đăng ký tài khoản TOMATO.',
  dateOfBirthOutOfRange: 'Ngày sinh nằm ngoài phạm vi hợp lệ.',
  termsRequired: 'Bạn cần đồng ý với Điều khoản sử dụng và Chính sách quyền riêng tư để tiếp tục.',
  captchaRequired: 'Vui lòng hoàn thành bước xác nhận bảo mật.',
  captchaInvalid: 'Bước xác nhận bảo mật không hợp lệ hoặc đã hết hạn. Vui lòng thử lại.',
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
