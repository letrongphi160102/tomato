import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { ProfileView } from '@/components/profile/profile-view';
import { sanitizeRedirectPath } from '@/lib/auth-client';
import { resolveServerAuthState } from '@/modules/auth/server-session';
import { ProfileDomainError, getProfileService, normalizeHandle } from '@/modules/profile';
import { SocialDomainError, getSocialService } from '@/modules/social';

export const dynamic = 'force-dynamic';

interface UserProfilePageProps {
  readonly params: Promise<{ readonly handle: string }>;
}

function safeDecodeHandle(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function generateMetadata({ params }: UserProfilePageProps): Promise<Metadata> {
  const { handle } = await params;
  const normalized = normalizeHandle(safeDecodeHandle(handle));
  return {
    title: normalized ? `@${normalized} — Tomato` : 'Trang cá nhân — Tomato',
  };
}

export default async function UserProfilePage({ params }: UserProfilePageProps) {
  const [{ handle }, authState] = await Promise.all([params, resolveServerAuthState()]);
  const decodedHandle = safeDecodeHandle(handle);

  if (authState.status !== 'authenticated') {
    const safeNext = sanitizeRedirectPath(`/u/${encodeURIComponent(decodedHandle)}`, '/');
    const loginTarget = safeNext !== '/' ? `/login?next=${encodeURIComponent(safeNext)}` : '/login';
    redirect(loginTarget);
  }

  let profile = null;
  try {
    // Tầng dịch vụ gọi trực tiếp `social.policy.ts` để kiểm tra chặn 2 chiều & tài khoản hoạt động.
    const result = await getProfileService().getProfileByHandle(
      authState.principal,
      decodedHandle,
      { skipRateLimit: true },
    );
    profile = result.profile;
  } catch (error) {
    if (
      (error instanceof ProfileDomainError && error.status === 404) ||
      (error instanceof SocialDomainError && error.status === 404)
    ) {
      notFound();
    }
    throw error;
  }

  if (!profile) {
    notFound();
  }

  let pendingFollowRequestsCount = 0;
  if (profile.isOwnProfile) {
    const privacyState = await getSocialService().getOwnPrivacySettings(authState.principal);
    pendingFollowRequestsCount = privacyState.privacy.pendingFollowRequestsCount;
  }

  return (
    <ProfileView
      key={profile.public_id}
      initialProfile={profile}
      initialPendingRequestsCount={pendingFollowRequestsCount}
    />
  );
}
