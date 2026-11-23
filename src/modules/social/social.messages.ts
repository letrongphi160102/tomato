/**
 * Bộ từ điển thông báo Tiếng Việt tự nhiên cho phân hệ Kết nối, Riêng tư & Chặn.
 * Tuyệt đối không chứa thuật ngữ kỹ thuật hay nhãn tiến độ.
 */
export const SOCIAL_MESSAGES = Object.freeze({
  // Dùng cùng một thông điệp với Profile để không phân biệt giữa không tồn tại, bị chặn hay không có quyền.
  notFound: 'Không tìm thấy người dùng được yêu cầu.',
  cannotFollowSelf: 'Bạn không thể tự theo dõi chính mình.',
  cannotBlockSelf: 'Bạn không thể chặn chính mình.',
  invalidSelfAction: 'Thao tác này không thể thực hiện trên chính tài khoản của bạn.',
  followed: 'Đã bắt đầu theo dõi.',
  followRequested: 'Đã gửi yêu cầu theo dõi.',
  unfollowed: 'Đã hủy theo dõi.',
  followRequestCancelled: 'Đã hủy yêu cầu theo dõi.',
  followRequestAccepted: 'Đã chấp nhận yêu cầu theo dõi.',
  followRequestDeclined: 'Đã xóa yêu cầu theo dõi.',
  followerRemoved: 'Đã gỡ người theo dõi.',
  userBlocked: 'Đã chặn tài khoản này.',
  userUnblocked: 'Đã bỏ chặn tài khoản này.',
  privacyEnabled: 'Đã chuyển sang tài khoản riêng tư.',
  privacyDisabled: 'Đã chuyển sang tài khoản công khai.',
  privacyUpdated: 'Đã cập nhật cài đặt quyền riêng tư.',
  validationFailed: 'Thông tin yêu cầu chưa hợp lệ. Vui lòng kiểm tra lại.',
  invalidCursor: 'Thông tin phân trang không hợp lệ.',
  invalidLimit: 'Số lượng mục yêu cầu không hợp lệ.',
  searchQueryTooLong: 'Từ khóa tìm kiếm quá dài.',
  rateLimited: (retryAfterSeconds: number) =>
    `Bạn thao tác quá nhanh. Vui lòng thử lại sau ${retryAfterSeconds} giây.`,
});
