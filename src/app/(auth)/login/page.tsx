import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { LoginForm } from '@/components/auth/login-form';
import { SilentSessionGate } from '@/components/auth/silent-session-gate';
import { getEnv } from '@/core/config/env';
import { sanitizeRedirectPath } from '@/lib/auth-client';
import { resolveServerAuthState } from '@/modules/auth/server-session';

export const metadata: Metadata = {
  title: 'Đăng nhập — Tomato',
  description: 'Đăng nhập vào tài khoản mạng xã hội Tomato.',
};

export const dynamic = 'force-dynamic';

interface LoginPageProps {
  readonly searchParams: Promise<{ readonly next?: string | string[] }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const [params, requestHeaders, authState] = await Promise.all([
    searchParams,
    headers(),
    resolveServerAuthState(),
  ]);
  const rawNext = Array.isArray(params.next) ? params.next[0] : params.next;
  const safeNextPath = sanitizeRedirectPath(rawNext, '/');

  if (authState.status === 'authenticated') {
    redirect(safeNextPath);
  }

  const cspNonce = requestHeaders.get('x-nonce') ?? undefined;
  const env = getEnv();

  const loginForm = (
    <LoginForm
      nextPath={safeNextPath}
      turnstileSiteKey={env.NEXT_PUBLIC_TURNSTILE_SITE_KEY}
      cspNonce={cspNonce}
    />
  );

  if (authState.status === 'needs_refresh') {
    return <SilentSessionGate mode="auth-redirect" nextPath={safeNextPath} fallback={loginForm} />;
  }

  return loginForm;
}
