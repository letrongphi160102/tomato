import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { SilentSessionGate } from '@/components/auth/silent-session-gate';
import { AppShell } from '@/components/layout/app-shell';
import { sanitizeRedirectPath } from '@/lib/auth-client';
import { resolveServerAuthState } from '@/modules/auth/server-session';

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: Readonly<{ children: ReactNode }>) {
  const [requestHeaders, authState] = await Promise.all([headers(), resolveServerAuthState()]);
  const safeNextPath = sanitizeRedirectPath(requestHeaders.get('x-tomato-pathname'), '/');

  if (authState.status === 'authenticated') {
    return (
      <AppShell user={authState.user} profile={authState.profile}>
        {children}
      </AppShell>
    );
  }

  if (authState.status === 'needs_refresh') {
    return <SilentSessionGate mode="protected" nextPath={safeNextPath} />;
  }

  const loginTarget =
    safeNextPath !== '/' ? `/login?next=${encodeURIComponent(safeNextPath)}` : '/login';
  redirect(loginTarget);
}
