import 'server-only';

export const CHAT_MESSAGES = Object.freeze({
  notFound: 'Không tìm thấy nội dung yêu cầu.',
  validationFailed: 'Dữ liệu gửi lên không hợp lệ.',
  cannotMessageSelf: 'Bạn không thể tự tạo cuộc trò chuyện với chính mình.',
  pendingTextOnly: 'Khi cuộc trò chuyện đang chờ chấp nhận, bạn chỉ có thể gửi tin nhắn văn bản.',
  pendingLimitReached:
    'Bạn chỉ có thể gửi tối đa 3 tin nhắn trước khi người nhận chấp nhận cuộc trò chuyện.',
  newPendingDailyQuotaExceeded: (retryAfterSeconds: number) =>
    `Bạn đã đạt giới hạn bắt đầu trò chuyện với 5 người mới trong ngày. Vui lòng thử lại sau ${Math.max(1, Math.ceil(retryAfterSeconds / 60))} phút.`,
  rateLimited: (retryAfterSeconds: number) =>
    `Bạn thao tác quá nhanh. Vui lòng thử lại sau ${retryAfterSeconds} giây.`,
  conversationAccepted: 'Đã chuyển cuộc trò chuyện vào hộp thư chính.',
  conversationDeclined: 'Đã xóa cuộc trò chuyện đang chờ.',
  conversationDeletedForMe: 'Đã xóa cuộc trò chuyện ở phía bạn.',
  messageDeletedForMe: 'Đã xóa tin nhắn ở phía bạn.',
  editForbiddenNotOwner: 'Bạn chỉ có thể chỉnh sửa tin nhắn do chính mình gửi.',
  recallForbiddenNotOwner: 'Bạn chỉ có thể thu hồi tin nhắn do chính mình gửi.',
  editWindowExpired: 'Đã quá thời hạn 5 phút để chỉnh sửa tin nhắn.',
  recallWindowExpired: 'Đã quá thời hạn 5 phút để thu hồi tin nhắn.',
  editLimitReached: 'Bạn đã đạt giới hạn tối đa 5 lần chỉnh sửa cho tin nhắn này.',
  alreadyRecalled: 'Tin nhắn này đã được thu hồi.',
  editUnsupportedType: 'Chỉ có thể chỉnh sửa tin nhắn văn bản.',
  editIvReused: 'Dữ liệu cập nhật không hợp lệ. Vui lòng thử lại.',
  deviceRegistered: 'Đã đồng bộ thiết bị nhắn tin.',
  backupSaved: 'Đã lưu mã PIN đồng bộ tin nhắn.',
  backupPinChanged: 'Đã đổi mã PIN tin nhắn thành công.',
  backupKeyChangeRequiresReset:
    'Không thể thay thế khóa đồng bộ trực tiếp. Vui lòng sử dụng tính năng Quên mã PIN để đặt lại.',
  backupNotFoundForReset: 'Tài khoản chưa thiết lập mã PIN tin nhắn.',
  pinResetEmailUnavailable: 'Không tìm thấy địa chỉ email đã xác minh cho tài khoản này.',
  pinResetOtpSent: 'Đã gửi mã xác nhận gồm 6 chữ số tới email tài khoản của bạn.',
  pinResetOtpInvalidOrExpired: 'Mã xác nhận không đúng hoặc đã hết hạn. Vui lòng thử lại.',
  pinResetOtpRevokedMaxAttempts:
    'Bạn đã nhập sai mã xác nhận quá 5 lần. Mã đã bị hủy, vui lòng gửi mã mới.',
  pinResetOtpIncorrectWithRemaining: (remaining: number) =>
    `Mã xác nhận không đúng. Bạn còn ${remaining} lần thử.`,
  pinResetCompleted: 'Đã đặt lại mã PIN tin nhắn thành công.',
});
