import type { Metadata } from 'next';

import { ForgotPasswordForm } from '@/components/auth/forgot-password-form';

export const metadata: Metadata = {
  title: 'Quên mật khẩu — TOMATO',
  description: 'Khôi phục quyền truy cập tài khoản TOMATO an toàn qua liên kết đặt lại mật khẩu.',
};

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}
