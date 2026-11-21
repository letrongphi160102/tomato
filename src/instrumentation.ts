export async function register(): Promise<void> {
  // Kiểm tra fail-fast ngay khi Node.js server khởi động (trước khi phục vụ bất kỳ request nào),
  // nhưng không ép buộc runtime secrets trong pha build tĩnh (`next build`).
  if (
    process.env.NEXT_RUNTIME === 'nodejs' &&
    process.env.NEXT_PHASE !== 'phase-production-build'
  ) {
    const { getEnv } = await import('@/core/config/env');
    try {
      getEnv();
    } catch (error) {
      // Next.js có thể bắt lỗi từ register() nhưng vẫn để tiến trình HTTP tiếp tục lắng nghe.
      // Bắt buộc dừng tiến trình ngay lập tức để đảm bảo fail-fast tuyệt đối khi sai cấu hình.
      console.error(error instanceof Error ? error.message : 'Lỗi cấu hình biến môi trường');
      process.exit(1);
    }
  }
}
