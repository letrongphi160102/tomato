import type { Metadata } from 'next';

import { ResetPasswordForm } from '@/components/auth/reset-password-form';

export const metadata: Metadata = {
  title: 'Đặt lại mật khẩu — TOMATO',
  description: 'Tạo mật khẩu mới an toàn cho tài khoản TOMATO của bạn.',
  // Lớp phòng thủ bổ sung bên cạnh HTTP header `Referrer-Policy: no-referrer` từ proxy.ts.
  referrer: 'no-referrer',
};

export const dynamic = 'force-dynamic';

/**
 * Chủ ý KHÔNG đọc `searchParams.token` tại Server Component để tránh nhúng token nhạy cảm
 * vào mã HTML/RSC payload truyền về trình duyệt; client component sẽ đọc và xóa ngay khỏi history.
 */
export default function ResetPasswordPage() {
  return <ResetPasswordForm />;
}
