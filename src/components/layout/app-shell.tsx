import type { ReactNode } from 'react';

import { AppTopBar } from '@/components/layout/app-top-bar';
import type { PublicUserProfile } from '@/modules/auth/session.service';

export interface AppShellProps {
  readonly user: PublicUserProfile;
  readonly children: ReactNode;
}

export function AppShell({ user, children }: AppShellProps) {
  return (
    <div className="min-h-screen bg-muted/30">
      <AppTopBar user={user} />
      <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-8">{children}</main>
    </div>
  );
}
