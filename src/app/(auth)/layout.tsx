import Link from 'next/link';
import type { ReactNode } from 'react';

import { TomatoLogo } from '@/components/brand/tomato-logo';

export default function AuthLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-muted/50 via-background to-background px-4 py-10">
      <div className="mb-6 flex flex-col items-center gap-1.5 text-center">
        <Link
          href="/"
          aria-label="Trang chủ Tomato"
          className="inline-flex items-center rounded-lg px-2 py-1 transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <TomatoLogo size="md" priority />
        </Link>
        <p className="text-sm text-muted-foreground">Kết nối và khám phá cùng nhau</p>
      </div>

      <main className="w-full max-w-md">{children}</main>
    </div>
  );
}
