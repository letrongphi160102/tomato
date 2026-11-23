import * as Sentry from '@sentry/nextjs';

export async function register(): Promise<void> {
  // 1. Kiểm tra fail-fast biến môi trường ngay khi Node.js server khởi động (không ép secrets lúc `next build`).
  if (
    process.env.NEXT_RUNTIME === 'nodejs' &&
    process.env.NEXT_PHASE !== 'phase-production-build'
  ) {
    const { EnvValidationError, getEnv } = await import('@/core/config/env');
    try {
      getEnv();
    } catch (error) {
      // Next.js có thể bắt lỗi từ register() nhưng vẫn để tiến trình HTTP tiếp tục lắng nghe.
      // Bắt buộc dừng tiến trình ngay lập tức để đảm bảo fail-fast tuyệt đối khi sai cấu hình.
      // Chỉ in message nếu là EnvValidationError (đã đảm bảo chỉ gồm tên biến, không có giá trị secret).
      console.error(
        error instanceof EnvValidationError
          ? error.message
          : 'Lỗi cấu hình biến môi trường khi khởi động ứng dụng',
      );
      process.exit(1);
    }

    await import('../sentry.server.config');
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config');
  }
}

export const onRequestError = Sentry.captureRequestError;
