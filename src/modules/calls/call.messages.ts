import 'server-only';

export const CALL_MESSAGES = Object.freeze({
  notFound: 'Không tìm thấy cuộc gọi yêu cầu.',
  validationFailed: 'Dữ liệu cuộc gọi không hợp lệ.',
  pendingCallForbidden:
    'Bạn chỉ có thể gọi thoại hoặc gọi video sau khi cuộc trò chuyện được chấp nhận.',
  callerBusy: 'Bạn đang ở trong một cuộc gọi khác.',
  calleeBusy: 'Người dùng đang bận trong một cuộc gọi khác.',
  alreadyEnded: 'Cuộc gọi này đã kết thúc.',
  invalidActionForRole: 'Bạn không thể thực hiện thao tác này cho cuộc gọi hiện tại.',
  invalidStateTransition: 'Không thể thực hiện thao tác ở trạng thái hiện tại của cuộc gọi.',
  timeoutTooEarly: 'Cuộc gọi vẫn đang đổ chuông.',
  rateLimited: (retryAfterSeconds: number) =>
    `Bạn thực hiện cuộc gọi quá nhanh. Vui lòng thử lại sau ${retryAfterSeconds} giây.`,
  declinedCooldown: (retryAfterSeconds: number) =>
    `Người nhận vừa từ chối cuộc gọi. Vui lòng thử lại sau ${retryAfterSeconds} giây.`,
  callStarted: 'Đang gọi...',
  callAccepted: 'Đã kết nối cuộc gọi.',
  callDeclined: 'Đã từ chối cuộc gọi.',
  callEnded: 'Cuộc gọi đã kết thúc.',
  callMissed: 'Cuộc gọi nhỡ.',
  callHeartbeatOk: 'Đã duy trì kết nối cuộc gọi.',
});
