import type { Metadata } from 'next';

import { VerifyEmailForm } from '@/components/auth/verify-email-form';

export const metadata: Metadata = {
  title: 'Xác minh email — Tomato',
  description: 'Nhập mã xác nhận 6 chữ số để hoàn tất tạo tài khoản Tomato.',
};

export default function VerifyEmailPage() {
  return <VerifyEmailForm />;
}
