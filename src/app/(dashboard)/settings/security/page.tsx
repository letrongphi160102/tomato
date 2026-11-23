import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, MonitorSmartphone } from 'lucide-react';

import { ChangePasswordCard } from '@/components/settings/change-password-card';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata: Metadata = {
  title: 'Mật khẩu & Bảo mật — TOMATO',
  description: 'Cập nhật mật khẩu và giữ an toàn cho tài khoản TOMATO của bạn.',
};

export const dynamic = 'force-dynamic';

export default function SecuritySettingsPage() {
  return (
    <div className="space-y-6">
      <ChangePasswordCard />

      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <MonitorSmartphone className="size-5 text-primary" aria-hidden="true" />
            <CardTitle className="text-base">Thiết bị đăng nhập</CardTitle>
          </div>
          <CardDescription>
            Kiểm tra nơi tài khoản của bạn đang đăng nhập và đăng xuất từ xa các thiết bị lạ.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/devices">
              Xem danh sách thiết bị
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
