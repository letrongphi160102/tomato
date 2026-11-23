import { config } from 'zod';

/**
 * Cấu hình Zod dùng chung cho cả Server lẫn Client, PHẢI được import TRƯỚC mọi khai báo schema:
 * - `jitless: true` tắt hoàn toàn nhánh tối ưu sinh mã bằng `new Function(...)` của Zod v4.
 * - Nhờ đó Zod không còn "dò thử" `new Function("")` khi khởi tạo `z.object(...)` trên trình duyệt,
 *   tránh bị CSP Production (không có `'unsafe-eval'`) chặn và báo vi phạm trong DevTools.
 * - Kết quả validate giữ nguyên 100%; chỉ bỏ đường tắt tăng tốc vốn đã bị CSP chặn trên trình duyệt.
 */
config({ jitless: true });
