import Link from 'next/link';
import { ArrowLeft, UserX } from 'lucide-react';

import { Button } from '@/components/ui/button';

export default function UserProfileNotFound() {
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
