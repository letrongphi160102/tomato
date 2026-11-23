/**
 * Bộ từ điển thông báo Tiếng Việt tự nhiên cho phân hệ Thông báo.
 * Tuyệt đối không chứa thuật ngữ kỹ thuật hay nhãn tiến độ.
 */
export const NOTIFICATION_MESSAGES = Object.freeze({
  notFound: 'Không tìm thấy thông báo được yêu cầu.',
  validationFailed: 'Thông tin yêu cầu chưa hợp lệ. Vui lòng kiểm tra lại.',
  invalidCursor: 'Thông tin phân trang không hợp lệ.',
  invalidLimit: 'Số lượng thông báo yêu cầu không hợp lệ.',
  invalidReadPayload: 'Vui lòng chọn thông báo cần đánh dấu hoặc đánh dấu tất cả là đã đọc.',
  rateLimited: (retryAfterSeconds: number) =>
    `Bạn thao tác quá nhanh. Vui lòng thử lại sau ${retryAfterSeconds} giây.`,
});
