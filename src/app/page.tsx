import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';

import { Button } from '@/components/ui/button';

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground">
        <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
        <span>Giai đoạn 1 — Cột mốc M3: Đăng nhập, Phiên &amp; Thiết bị</span>
      </div>
      <h1 className="text-4xl font-bold tracking-tight">TOMATO</h1>
      <p className="mt-3 text-base text-muted-foreground">
        Nền tảng mạng xã hội kiến trúc Modular Monolith với Argon2id + Pepper, xoay vòng Refresh
        Token (Reuse Detection), phòng thủ CSRF 3 lớp và quản lý thiết bị đăng nhập.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Button asChild size="lg">
          <Link href="/login">Đăng nhập</Link>
        </Button>
        <Button asChild variant="outline" size="lg">
          <Link href="/register">Đăng ký tài khoản</Link>
        </Button>
        <Button asChild variant="secondary" size="lg">
          <Link href="/settings/security">Quản lý Thiết bị</Link>
        </Button>
        <Button asChild variant="ghost" size="lg">
          <Link href="/api/health">Kiểm tra /api/health</Link>
        </Button>
      </div>
    </main>
  );
}
