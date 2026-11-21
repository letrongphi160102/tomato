import Link from 'next/link';
import type { ReactNode } from 'react';
import { ShieldCheck } from 'lucide-react';

export default function DashboardLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="min-h-screen bg-muted/30">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-4xl items-center justify-between px-4 sm:px-6">
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-md px-1 py-1 text-lg font-bold tracking-tight text-primary transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ShieldCheck className="size-5" aria-hidden="true" />
            <span>TOMATO</span>
          </Link>

          <nav aria-label="Điều hướng cài đặt" className="flex items-center gap-4 text-sm">
            <Link
              href="/settings/security"
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              Bảo mật &amp; Thiết bị
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
