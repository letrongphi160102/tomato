import Link from 'next/link';
import type { ReactNode } from 'react';
import { ShieldCheck } from 'lucide-react';

export default function AuthLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-muted/50 via-background to-background px-4 py-10">
      <div className="mb-6 flex flex-col items-center gap-2 text-center">
        <Link
          href="/"
          className="inline-flex items-center gap-2 rounded-lg px-2 py-1 text-2xl font-bold tracking-tight text-primary transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ShieldCheck className="size-6" aria-hidden="true" />
          <span>TOMATO</span>
        </Link>
        <p className="text-xs text-muted-foreground">
          Hệ thống Tài khoản &amp; Xác thực An toàn — Giai đoạn 1
        </p>
      </div>

      <main className="w-full max-w-md">{children}</main>
    </div>
  );
}
