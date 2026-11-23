/**
 * Bộ từ điển thông báo Tiếng Việt tự nhiên cho phân hệ Trạng thái Hoạt động.
 * Tuyệt đối không chứa thuật ngữ kỹ thuật hay nhãn tiến độ.
 */
export const PRESENCE_MESSAGES = Object.freeze({
  notFound: 'Không tìm thấy tài nguyên được yêu cầu.',
  validationFailed: 'Thông tin yêu cầu chưa hợp lệ. Vui lòng kiểm tra lại.',
  rateLimited: (retryAfterSeconds: number) =>
    `Bạn thao tác quá nhanh. Vui lòng thử lại sau ${retryAfterSeconds} giây.`,
  activeNow: 'Đang hoạt động',
  fewMinutesAgo: 'Hoạt động vài phút trước',
  minutesAgo: (minutes: number) => `Hoạt động ${minutes} phút trước`,
  hoursAgo: (hours: number) => `Hoạt động ${hours} giờ trước`,
  daysAgo: (days: number) => `Hoạt động ${days} ngày trước`,
});
