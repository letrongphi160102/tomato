import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { RegisterForm } from '@/components/auth/register-form';
import { SilentSessionGate } from '@/components/auth/silent-session-gate';
import { getEnv } from '@/core/config/env';
import { resolveServerAuthState } from '@/modules/auth/server-session';

export const metadata: Metadata = {
  title: 'Đăng ký tài khoản — Tomato',
  description: 'Tạo tài khoản mới để kết nối và khám phá cùng nhau trên Tomato.',
};

export const dynamic = 'force-dynamic';

export default async function RegisterPage() {
  const [requestHeaders, authState] = await Promise.all([headers(), resolveServerAuthState()]);

  if (authState.status === 'authenticated') {
    redirect('/');
  }

  const cspNonce = requestHeaders.get('x-nonce') ?? undefined;
  const env = getEnv();

  const registerForm = (
    <RegisterForm turnstileSiteKey={env.NEXT_PUBLIC_TURNSTILE_SITE_KEY} cspNonce={cspNonce} />
  );

  if (authState.status === 'needs_refresh') {
    return <SilentSessionGate mode="auth-redirect" nextPath="/" fallback={registerForm} />;
  }

  return registerForm;
}
