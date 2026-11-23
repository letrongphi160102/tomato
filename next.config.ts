import { withSentryConfig } from '@sentry/nextjs/config';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Ẩn header X-Powered-By để giảm lộ dấu vết công nghệ máy chủ.
  poweredByHeader: false,

  // Bắt buộc giữ nguyên ngoài bundler vì:
  // - @node-rs/argon2 chứa native Rust binary (.node) sẽ hỏng nếu bị đóng gói bởi bundler.
  // - sharp chứa native libvips C++ binary bắt buộc chạy ngoài bundler trên Node.js Runtime.
  // - pino & pino-pretty sử dụng worker thread (thread-stream) cần đường dẫn file gốc trên đĩa.
  // - nodemailer dùng giao thức socket/TLS thuần Node.js, tránh cảnh báo/lỗi đóng gói trên Turbopack.
  serverExternalPackages: ['@node-rs/argon2', 'sharp', 'pino', 'pino-pretty', 'nodemailer', 'ably'],
};

const hasSentryUploadAuth = Boolean(
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT,
);

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  telemetry: false,
  // Chỉ tạo & tải source maps khi có đủ thông tin xác thực Sentry (không làm hỏng build local/CI).
  // Tự động xóa `.map` sau khi tải lên để không lộ mã nguồn gốc cho trình duyệt.
  sourcemaps: {
    disable: !hasSentryUploadAuth,
    deleteSourcemapsAfterUpload: true,
  },
  // Loại bỏ hoàn toàn mã debug và Session Replay khỏi bundle client.
  bundleSizeOptimizations: {
    excludeDebugStatements: true,
    excludeReplayShadowDom: true,
    excludeReplayIframe: true,
    excludeReplayWorker: true,
  },
});
