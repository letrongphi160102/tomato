import type { ReactNode } from 'react';

import { AppTopBar } from '@/components/layout/app-top-bar';
import { ChatStoreProvider } from '@/components/messages/chat-store-provider';
import { RealtimePresenceProvider } from '@/components/realtime/realtime-presence-provider';
import type { PublicUserProfile } from '@/modules/auth/session.service';
import type { UserProfileDto } from '@/modules/profile';

export interface AppShellProps {
  readonly user: PublicUserProfile;
  readonly profile?: Pick<UserProfileDto, 'handle' | 'avatarUrl'>;
  readonly initialShowActiveStatus?: boolean;
  readonly initialShowReadReceipts?: boolean;
  readonly initialAccessTokenRemainingMs?: number;
  readonly children: ReactNode;
}

export function AppShell({
  user,
  profile,
  initialShowActiveStatus = true,
  initialShowReadReceipts = true,
  initialAccessTokenRemainingMs,
  children,
}: AppShellProps) {
  return (
    <RealtimePresenceProvider
      currentUserPublicId={user.public_id}
      initialShowActiveStatus={initialShowActiveStatus}
      initialShowReadReceipts={initialShowReadReceipts}
      initialAccessTokenRemainingMs={initialAccessTokenRemainingMs}
    >
      <ChatStoreProvider currentUserPublicId={user.public_id}>
        <div className="min-h-screen bg-muted/30">
          <AppTopBar
            user={user}
            avatarUrl={profile?.avatarUrl ?? null}
            handle={profile?.handle ?? user.username}
          />
          <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-8">{children}</main>
        </div>
      </ChatStoreProvider>
    </RealtimePresenceProvider>
  );
}
