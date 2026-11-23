import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, UserX } from 'lucide-react';

import { ProfileView } from '@/components/profile/profile-view';
import { Button } from '@/components/ui/button';
import { sanitizeRedirectPath } from '@/lib/auth-client';
import { resolveServerAuthState } from '@/modules/auth/server-session';
import { ProfileDomainError, getProfileService, normalizeHandle } from '@/modules/profile';

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
    const result = await getProfileService().getProfileByHandle(
      authState.principal,
      decodedHandle,
      { skipRateLimit: true },
    );
    profile = result.profile;
  } catch (error) {
    if (!(error instanceof ProfileDomainError && error.status === 404)) {
      throw error;
    }
  }

  if (!profile) {
    return (
      <div className="mx-auto max-w-lg py-12">
        <div className="rounded-2xl border bg-background px-6 py-12 text-center shadow-sm">
          <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <UserX className="size-6" aria-hidden="true" />
          </div>
          <h1 className="mt-4 text-lg font-semibold text-foreground">
            Trang này hiện không khả dụng
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Liên kết bạn truy cập có thể không đúng hoặc tài khoản này không tồn tại.
          </p>
          <Button asChild size="sm" className="mt-6">
            <Link href="/">
              <ArrowLeft className="size-4" aria-hidden="true" />
              <span>Quay về trang chủ</span>
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  return <ProfileView profile={profile} />;
}
