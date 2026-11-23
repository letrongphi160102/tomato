import { SilentSessionGate } from '@/components/auth/silent-session-gate';
import { AuthenticatedHome } from '@/components/home/authenticated-home';
import { LandingHero } from '@/components/home/landing-hero';
import { AppShell } from '@/components/layout/app-shell';
import { resolveServerAuthState } from '@/modules/auth/server-session';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const authState = await resolveServerAuthState();
  const showDevHealthLink = process.env.NODE_ENV === 'development';

  if (authState.status === 'authenticated') {
    return (
      <AppShell user={authState.user}>
        <AuthenticatedHome user={authState.user} />
      </AppShell>
    );
  }

  if (authState.status === 'needs_refresh') {
    return (
      <SilentSessionGate
        mode="home"
        fallback={<LandingHero showDevHealthLink={showDevHealthLink} />}
      />
    );
  }

  return <LandingHero showDevHealthLink={showDevHealthLink} />;
}
