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
  recallUnsupportedType: 'Không thể thu hồi thẻ sự kiện cuộc gọi.',
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
  attachmentTooLargeImage: 'Ảnh đính kèm vượt quá giới hạn tối đa 10 MB.',
  attachmentTooLargeVoice: 'Tin nhắn thoại vượt quá giới hạn tối đa 5 MB.',
  attachmentUploadNotReady: 'Tệp đính kèm chưa được tải lên hoàn tất. Vui lòng thử lại.',
  attachmentAlreadyBound: 'Tệp đính kèm này đã được sử dụng cho một tin nhắn khác.',
  attachmentTypeMismatch: 'Loại tệp đính kèm không khớp với loại tin nhắn.',
  attachmentIntegrityMismatch: 'Tệp tải lên không khớp kích thước hoặc dữ liệu đã khai báo.',
  attachmentInvalidContentType: 'Định dạng truyền tải tệp không hợp lệ.',
  pendingInteractionForbidden:
    'Bạn cần chấp nhận cuộc trò chuyện trước khi thả cảm xúc hoặc ghim tin nhắn.',
  pendingPinConversationForbidden: 'Chỉ có thể ghim cuộc trò chuyện trong hộp thư chính.',
  forwardTargetNotEligible:
    'Chỉ có thể chuyển tiếp cho người cùng theo dõi nhau hoặc người đã từng trò chuyện.',
  reactionUnsupportedType: 'Không thể thả cảm xúc cho tin nhắn này.',
  pinUnsupportedType: 'Không thể ghim tin nhắn này.',
  replyUnsupportedType: 'Không thể trả lời tin nhắn này.',
  pinnedMessagesLimitReached:
    'Đã đạt giới hạn tối đa 5 tin nhắn được ghim. Vui lòng gỡ ghim một tin nhắn trước khi ghim thêm.',
  pinnedMessagesLimitReachedWithHidden:
    'Cuộc trò chuyện đã đạt tối đa 5 tin nhắn được ghim (bao gồm tin nhắn cũ không còn hiển thị ở phía bạn). Bạn có thể gỡ ghim tin cũ để ghim tin mới.',
  pinnedConversationsLimitReached:
    'Bạn chỉ có thể ghim tối đa 3 đoạn chat. Hãy bỏ ghim một đoạn chat khác trước khi ghim thêm.',
  reactionUpdated: 'Đã cập nhật cảm xúc.',
  reactionRemoved: 'Đã gỡ cảm xúc.',
  messagePinned: 'Đã ghim tin nhắn.',
  messageUnpinned: 'Đã gỡ ghim tin nhắn.',
  conversationPreferencesUpdated: 'Đã cập nhật tùy chọn cuộc trò chuyện.',
});
