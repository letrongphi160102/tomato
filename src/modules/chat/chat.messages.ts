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
  deviceRegistered: 'Đã đồng bộ thiết bị nhắn tin.',
  backupSaved: 'Đã lưu mã PIN đồng bộ tin nhắn.',
});
