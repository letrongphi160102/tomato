import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { EditProfileForm } from '@/components/settings/edit-profile-form';
import { resolveServerAuthState } from '@/modules/auth/server-session';
import { getProfileService } from '@/modules/profile';

export const metadata: Metadata = {
  title: 'Chỉnh sửa hồ sơ — Tomato',
  description: 'Cập nhật ảnh đại diện, tên hiển thị, ID tài khoản và tiểu sử của bạn trên Tomato.',
};

export const dynamic = 'force-dynamic';

export default async function ProfileSettingsPage() {
  const authState = await resolveServerAuthState();
  if (authState.status !== 'authenticated') {
    redirect('/login?next=/settings/profile');
  }

  const { profile } = await getProfileService().getOwnProfile(authState.principal);
  return <EditProfileForm initialProfile={profile} />;
}
