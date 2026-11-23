import Link from 'next/link';

import { TomatoLogo } from '@/components/brand/tomato-logo';
import { Button } from '@/components/ui/button';

export interface LandingHeroProps {
  /** Chỉ hiển thị nút kiểm tra `/api/health` khi chạy phát triển cục bộ (`NODE_ENV === 'development'`). */
  readonly showDevHealthLink: boolean;
}

export function LandingHero({ showDevHealthLink }: LandingHeroProps) {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center px-6 text-center">
      <h1 className="sr-only">Tomato</h1>
      <TomatoLogo size="lg" priority />
      <p className="mt-4 text-lg text-muted-foreground">Kết nối và khám phá cùng nhau</p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Button asChild size="lg">
          <Link href="/login">Đăng nhập</Link>
        </Button>
        <Button asChild variant="outline" size="lg">
          <Link href="/register">Đăng ký tài khoản</Link>
        </Button>
        {showDevHealthLink ? (
          <Button asChild variant="ghost" size="lg">
            <Link href="/api/health">Kiểm tra /api/health</Link>
          </Button>
        ) : null}
      </div>
    </main>
  );
}
