import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { DisplaySettingsPanel } from '@/components/settings/display-settings-panel';
import { resolveServerAuthState } from '@/modules/auth/server-session';

export const metadata: Metadata = {
  title: 'Giao diện — Tomato',
  description: 'Tùy chỉnh chế độ hiển thị Sáng, Tối hoặc Tự động trên Tomato.',
};

export const dynamic = 'force-dynamic';

export default async function DisplaySettingsPage() {
  const authState = await resolveServerAuthState();
  if (authState.status !== 'authenticated') {
    redirect('/login?next=%2Fsettings%2Fdisplay');
  }

  return <DisplaySettingsPanel />;
}
