import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { ProfileView } from '@/components/profile/profile-view';
import { sanitizeRedirectPath } from '@/lib/auth-client';
import { resolveServerAuthState, type ServerAuthState } from '@/modules/auth/server-session';
import { ProfileDomainError, getProfileService, type UserProfileDto } from '@/modules/profile';
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

type ResolvedProfileLookup =
  | { readonly kind: 'unauthenticated'; readonly decodedHandle: string }
  | { readonly kind: 'not_found' }
  | {
      readonly kind: 'ok';
      readonly profile: UserProfileDto;
      readonly authState: Extract<ServerAuthState, { readonly status: 'authenticated' }>;
    };

/**
 * Dùng `React.cache` để chia sẻ đúng 1 lượt kiểm tra phiên & chặn 2 chiều giữa `generateMetadata`
 * và `UserProfilePage` trong cùng một request SSR:
 * - Nếu chưa đăng nhập, tài khoản không tồn tại hoặc bị chặn 2 chiều (A chặn B hoặc B chặn A):
 *   TUYỆT ĐỐI không rò rỉ tên, handle, ảnh hay tiểu sử trong `<title>` / OpenGraph và trả HTTP 404 đồng nhất.
 */
const resolveProfileForRequest = cache(
  async (rawHandle: string): Promise<ResolvedProfileLookup> => {
    const decodedHandle = safeDecodeHandle(rawHandle);
    const authState = await resolveServerAuthState();

    if (authState.status !== 'authenticated') {
      return { kind: 'unauthenticated', decodedHandle };
    }

    try {
      const result = await getProfileService().getProfileByHandle(
        authState.principal,
        decodedHandle,
        { skipRateLimit: true },
      );
      if (!result.profile) {
        return { kind: 'not_found' };
      }
      return { kind: 'ok', profile: result.profile, authState };
    } catch (error) {
      if (
        (error instanceof ProfileDomainError && error.status === 404) ||
        (error instanceof SocialDomainError && error.status === 404)
      ) {
        return { kind: 'not_found' };
      }
      throw error;
    }
  },
);

export async function generateMetadata({ params }: UserProfilePageProps): Promise<Metadata> {
  const { handle } = await params;
  const resolved = await resolveProfileForRequest(handle);

  if (resolved.kind !== 'ok') {
    return {
      title: 'Trang không khả dụng — Tomato',
      robots: { index: false, follow: false },
    };
  }

  return {
    title: `@${resolved.profile.handle} — Tomato`,
    robots: { index: false, follow: false },
  };
}

export default async function UserProfilePage({ params }: UserProfilePageProps) {
  const { handle } = await params;
  const resolved = await resolveProfileForRequest(handle);

  if (resolved.kind === 'unauthenticated') {
    const safeNext = sanitizeRedirectPath(`/u/${encodeURIComponent(resolved.decodedHandle)}`, '/');
    const loginTarget = safeNext !== '/' ? `/login?next=${encodeURIComponent(safeNext)}` : '/login';
    redirect(loginTarget);
  }

  if (resolved.kind === 'not_found') {
    notFound();
  }

  const { profile, authState } = resolved;

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
