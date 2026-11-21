import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';

import { Button } from '@/components/ui/button';

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground">
        <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
        <span>Giai đoạn 1 — Cột mốc M0: Kiến trúc nền</span>
      </div>
      <h1 className="text-4xl font-bold tracking-tight">TOMATO</h1>
      <p className="mt-3 text-base text-muted-foreground">
        Khung kiến trúc Modular Monolith (Next.js App Router, TypeScript strict, Tailwind CSS,
        shadcn/ui) đã sẵn sàng cho các cột mốc Xác thực &amp; Quản lý Phiên tiếp theo.
      </p>
      <div className="mt-6 flex items-center gap-3">
        <Button asChild>
          <Link href="/api/health">Kiểm tra /api/health</Link>
        </Button>
      </div>
    </main>
  );
}
