import type { Metadata } from 'next';

import { ForgotPasswordForm } from '@/components/auth/forgot-password-form';

export const metadata: Metadata = {
  title: 'Quên mật khẩu — Tomato',
  description: 'Khôi phục mật khẩu tài khoản Tomato của bạn qua email.',
};

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}
