import { redirect } from 'next/navigation';

import { SilentSessionGate } from '@/components/auth/silent-session-gate';
import { AuthenticatedHome } from '@/components/home/authenticated-home';
import { resolveServerAuthState } from '@/modules/auth/server-session';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const authState = await resolveServerAuthState();

  if (authState.status === 'authenticated') {
    return <AuthenticatedHome user={authState.user} profile={authState.profile} />;
  }

  if (authState.status === 'needs_refresh') {
    return <SilentSessionGate mode="protected" nextPath="/" />;
  }

  redirect('/login');
}
