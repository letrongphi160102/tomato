import type { Metadata } from 'next';

import { VerifyEmailForm } from '@/components/auth/verify-email-form';

export const metadata: Metadata = {
  title: 'Xác minh email — TOMATO',
  description: 'Nhập mã OTP 6 chữ số để xác minh địa chỉ email và kích hoạt tài khoản TOMATO.',
};

export default function VerifyEmailPage() {
  return <VerifyEmailForm />;
}
