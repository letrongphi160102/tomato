import type { Metadata } from 'next';

import { LoginForm } from '@/components/auth/login-form';
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
  const params = await searchParams;
  const rawNext = Array.isArray(params.next) ? params.next[0] : params.next;
  const safeNextPath = sanitizeRedirectPath(rawNext, '/settings/security');

  return <LoginForm nextPath={safeNextPath} />;
}
