import Link from 'next/link';

import { Button } from '@/components/ui/button';

export interface LandingHeroProps {
  /** Chỉ hiển thị nút kiểm tra `/api/health` khi chạy phát triển cục bộ (`NODE_ENV === 'development'`). */
  readonly showDevHealthLink: boolean;
}

export function LandingHero({ showDevHealthLink }: LandingHeroProps) {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-primary text-2xl font-extrabold text-primary-foreground shadow-sm">
        T
      </div>
      <h1 className="text-4xl font-bold tracking-tight text-foreground sm:text-5xl">TOMATO</h1>
      <p className="mt-3 text-lg text-muted-foreground">Kết nối và khám phá cùng nhau</p>
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
