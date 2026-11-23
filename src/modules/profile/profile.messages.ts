/**
 * Bộ từ điển thông báo Tiếng Việt thân thiện cho phân hệ Hồ sơ, Tìm kiếm & Ảnh đại diện.
 * Tuyệt đối không chứa thuật ngữ kỹ thuật hay nhãn nội bộ.
 */
export const PROFILE_MESSAGES = Object.freeze({
  profileNotFound: 'Không tìm thấy người dùng được yêu cầu.',
  profileUpdated: 'Đã lưu thay đổi hồ sơ của bạn.',
  avatarUpdated: 'Đã cập nhật ảnh đại diện thành công.',
  avatarRemoved: 'Đã gỡ ảnh đại diện.',
  invalidAvatar: 'Ảnh không hợp lệ hoặc vượt quá kích thước cho phép.',
  avatarFileRequired: 'Vui lòng chọn một tệp ảnh để tải lên.',
  handleUnavailable: 'ID tài khoản này hiện không khả dụng. Vui lòng chọn ID khác.',
  handleChangeLimitReached:
    'Bạn đã đổi ID tài khoản 2 lần trong 14 ngày qua. Vui lòng thử lại sau.',
  updateEmptyPayload: 'Vui lòng thay đổi ít nhất một thông tin để lưu.',
  fullNameRequired: 'Vui lòng nhập tên hiển thị.',
  fullNameTooShort: 'Tên hiển thị phải có ít nhất 2 ký tự.',
  fullNameTooLong: 'Tên hiển thị không được vượt quá 50 ký tự.',
  fullNameInvalidChars: 'Tên hiển thị chứa ký tự không hợp lệ.',
  handleRequired: 'Vui lòng nhập ID tài khoản.',
  handleNoSpaces: 'ID tài khoản không được chứa khoảng trắng.',
  handleTooShort: 'ID tài khoản phải có ít nhất 3 ký tự.',
  handleTooLong: 'ID tài khoản không được vượt quá 30 ký tự.',
  handleInvalidChars:
    'ID tài khoản chỉ được chứa chữ cái thường không dấu, chữ số, dấu chấm (.) và gạch dưới (_).',
  handleInvalidDots:
    'ID tài khoản không được bắt đầu, kết thúc bằng dấu chấm hoặc chứa hai dấu chấm liên tiếp.',
  handleReserved: 'ID tài khoản này không thể sử dụng. Vui lòng chọn ID khác.',
  bioTooLong: 'Tiểu sử không được vượt quá 160 ký tự.',
  bioTooManyLines: 'Tiểu sử chỉ hỗ trợ tối đa 4 dòng.',
  bioInvalidChars: 'Tiểu sử chứa ký tự không hợp lệ.',
  searchQueryTooShort: 'Vui lòng nhập ít nhất 2 ký tự để tìm kiếm.',
  searchQueryTooLong: 'Từ khóa tìm kiếm quá dài.',
  searchLimitInvalid: 'Số lượng kết quả yêu cầu không hợp lệ.',
  validationFailed: 'Thông tin nhập vào chưa hợp lệ. Vui lòng kiểm tra lại.',
  rateLimited: (retryAfterSeconds: number) =>
    `Bạn thao tác quá nhanh. Vui lòng thử lại sau ${retryAfterSeconds} giây.`,
  avatarRateLimited: 'Bạn đã thay đổi ảnh đại diện quá nhiều lần. Vui lòng thử lại sau ít phút.',
});
