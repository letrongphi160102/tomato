import type { Metadata } from 'next';

import { VerifyEmailForm } from '@/components/auth/verify-email-form';

export const metadata: Metadata = {
  title: 'Xác minh email — TOMATO',
  description: 'Nhập mã xác nhận 6 chữ số để hoàn tất tạo tài khoản TOMATO.',
};

export default function VerifyEmailPage() {
  return <VerifyEmailForm />;
}
