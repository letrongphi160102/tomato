import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { PrivacySettingsPanel } from '@/components/settings/privacy-settings-panel';
import { resolveServerAuthState } from '@/modules/auth/server-session';
import { getSocialService } from '@/modules/social';

export const metadata: Metadata = {
  title: 'Quyền riêng tư — Tomato',
  description: 'Quản lý chế độ tài khoản riêng tư và danh sách tài khoản đã chặn trên Tomato.',
};

export const dynamic = 'force-dynamic';

export default async function PrivacySettingsPage() {
  const authState = await resolveServerAuthState();
  if (authState.status !== 'authenticated') {
    redirect('/login?next=/settings/privacy');
  }

  const socialService = getSocialService();
  const [privacyResult, blockedResult] = await Promise.all([
    socialService.getOwnPrivacySettings(authState.principal),
    socialService.listBlockedUsers(authState.principal, { limit: 20 }, { skipRateLimit: true }),
  ]);

  return (
    <PrivacySettingsPanel
      initialPrivacy={privacyResult.privacy}
      initialBlockedItems={blockedResult.items}
      initialBlockedNextCursor={blockedResult.nextCursor}
    />
  );
}
