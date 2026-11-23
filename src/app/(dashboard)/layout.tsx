import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';

import { SilentSessionGate } from '@/components/auth/silent-session-gate';
import { AppShell } from '@/components/layout/app-shell';
import { resolveServerAuthState } from '@/modules/auth/server-session';

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: Readonly<{ children: ReactNode }>) {
  const authState = await resolveServerAuthState();

  if (authState.status === 'authenticated') {
    return <AppShell user={authState.user}>{children}</AppShell>;
  }

  if (authState.status === 'needs_refresh') {
    return <SilentSessionGate mode="protected" nextPath="/settings" />;
  }

  redirect('/login?next=/settings');
}
