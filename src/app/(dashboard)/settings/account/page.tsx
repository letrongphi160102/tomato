import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { AccountOverviewCard } from '@/components/settings/account-overview-card';
import { resolveServerAuthState } from '@/modules/auth/server-session';

export const metadata: Metadata = {
  title: 'Tổng quan tài khoản — TOMATO',
  description: 'Xem và quản lý thông tin tài khoản TOMATO của bạn.',
};

export const dynamic = 'force-dynamic';

export default async function AccountSettingsPage() {
  const authState = await resolveServerAuthState();
  if (authState.status !== 'authenticated') {
    redirect('/login?next=/settings/account');
  }

  return <AccountOverviewCard user={authState.user} />;
}
