import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Ẩn header X-Powered-By để giảm lộ dấu vết công nghệ máy chủ.
  poweredByHeader: false,

  // Bắt buộc giữ nguyên ngoài bundler vì:
  // - @node-rs/argon2 chứa native Rust binary (.node) sẽ hỏng nếu bị đóng gói bởi bundler.
  // - pino & pino-pretty sử dụng worker thread (thread-stream) cần đường dẫn file gốc trên đĩa.
  serverExternalPackages: ['@node-rs/argon2', 'pino', 'pino-pretty'],
};

export default nextConfig;
