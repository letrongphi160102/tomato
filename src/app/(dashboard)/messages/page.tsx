import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { MessagesView } from '@/components/messages/messages-view';
import { resolveServerAuthState } from '@/modules/auth/server-session';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Tin nhắn · Tomato',
  description: 'Trò chuyện riêng tư với bạn bè trên Tomato.',
};

export default async function MessagesPage() {
  const authState = await resolveServerAuthState();
  if (authState.status !== 'authenticated') {
    redirect('/login?next=%2Fmessages');
  }

  const effectiveHandle = authState.profile?.handle ?? authState.user.username;

  return (
    <MessagesView
      currentUserPublicId={authState.user.public_id}
      currentUserHandle={effectiveHandle}
      currentUserFullName={authState.user.fullName}
    />
  );
}
