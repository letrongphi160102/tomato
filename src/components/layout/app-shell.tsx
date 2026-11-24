import type { ReactNode } from 'react';

import { AppLeftSidebar } from '@/components/layout/app-left-sidebar';
import { AppTopBar } from '@/components/layout/app-top-bar';
import { ChatStoreProvider } from '@/components/messages/chat-store-provider';
import { FloatingMessagesWidget } from '@/components/messages/floating-messages-widget';
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
          <div className="flex min-h-[calc(100vh-3.5rem)]">
            <AppLeftSidebar />
            {/* Cột giữ chỗ cố định 72px trên Desktop để chống giật bố cục (Zero Layout Shift) khi Sidebar trượt mở rộng */}
            <div className="hidden w-[72px] shrink-0 md:block" aria-hidden="true" />
            <main className="mx-auto w-full max-w-5xl flex-1 px-4 pt-6 pb-20 sm:px-6 md:py-8">
              {children}
            </main>
          </div>
          <FloatingMessagesWidget />
        </div>
      </ChatStoreProvider>
    </RealtimePresenceProvider>
  );
}
