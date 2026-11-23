'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

import { refreshAuthSession, sanitizeRedirectPath } from '@/lib/auth-client';

export interface SilentSessionGateProps {
  /**
   * - `home`: đang ở `/` với Access Token hết hạn nhưng còn Refresh Token -> silent refresh rồi làm mới cây Server Component.
   * - `auth-redirect`: đang ở `/login` hoặc `/register` với Refresh Token còn hạn -> silent refresh rồi chuyển thẳng vào `nextPath`.
   * - `protected`: đang ở trang bảo vệ (`/settings/*`) với Refresh Token còn hạn -> silent refresh rồi tải lại, thất bại thì về `/login`.
   */
  readonly mode: 'home' | 'auth-redirect' | 'protected';
  readonly nextPath?: string;
  readonly fallback?: React.ReactNode;
}

export function SilentSessionGate({ mode, nextPath = '/', fallback }: SilentSessionGateProps) {
  const router = useRouter();
  const safeNextPath = sanitizeRedirectPath(nextPath, '/');
  const [phase, setPhase] = React.useState<'checking' | 'redirecting' | 'fallback'>('checking');

  React.useEffect(() => {
    let active = true;

    async function tryRestoreSession() {
      const refreshed = await refreshAuthSession();
      if (!active) {
        return;
      }

      if (refreshed) {
        setPhase('redirecting');
        if (mode === 'auth-redirect') {
          router.replace(safeNextPath);
          router.refresh();
          return;
        }
        router.refresh();
        return;
      }

      if (mode === 'protected') {
        const loginTarget =
          safeNextPath !== '/' ? `/login?next=${encodeURIComponent(safeNextPath)}` : '/login';
        router.replace(loginTarget);
        return;
      }

      setPhase('fallback');
    }

    void tryRestoreSession();
    return () => {
      active = false;
    };
  }, [mode, safeNextPath, router]);

  if (phase === 'fallback') {
    return <>{fallback ?? null}</>;
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="flex flex-col items-center gap-3 text-center">
        <Loader2 className="size-6 animate-spin text-primary" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">
          {phase === 'redirecting'
            ? 'Đang đưa bạn vào Tomato...'
            : 'Đang khôi phục phiên của bạn...'}
        </p>
      </div>
    </div>
  );
}
