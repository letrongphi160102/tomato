import type { Metadata } from 'next';
import { headers } from 'next/headers';

import { LoginForm } from '@/components/auth/login-form';
import { getEnv } from '@/core/config/env';
import { sanitizeRedirectPath } from '@/lib/auth-client';

export const metadata: Metadata = {
  title: 'Đăng nhập — TOMATO',
  description: 'Đăng nhập an toàn vào tài khoản mạng xã hội TOMATO.',
};

export const dynamic = 'force-dynamic';

interface LoginPageProps {
  readonly searchParams: Promise<{ readonly next?: string | string[] }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const [params, requestHeaders] = await Promise.all([searchParams, headers()]);
  const rawNext = Array.isArray(params.next) ? params.next[0] : params.next;
  const safeNextPath = sanitizeRedirectPath(rawNext, '/settings/security');
  const cspNonce = requestHeaders.get('x-nonce') ?? undefined;
  const env = getEnv();

  return (
    <LoginForm
      nextPath={safeNextPath}
      turnstileSiteKey={env.NEXT_PUBLIC_TURNSTILE_SITE_KEY}
      cspNonce={cspNonce}
    />
  );
}
