import type { Metadata } from 'next';
import { headers } from 'next/headers';

import { RegisterForm } from '@/components/auth/register-form';
import { getEnv } from '@/core/config/env';

export const metadata: Metadata = {
  title: 'Đăng ký tài khoản — TOMATO',
  description: 'Tạo tài khoản mạng xã hội TOMATO và xác minh địa chỉ email bằng mã OTP.',
};

export const dynamic = 'force-dynamic';

export default async function RegisterPage() {
  const requestHeaders = await headers();
  const cspNonce = requestHeaders.get('x-nonce') ?? undefined;
  const env = getEnv();

  return <RegisterForm turnstileSiteKey={env.NEXT_PUBLIC_TURNSTILE_SITE_KEY} cspNonce={cspNonce} />;
}
