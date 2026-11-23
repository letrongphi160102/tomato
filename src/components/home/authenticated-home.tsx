import Link from 'next/link';
import { ArrowRight, KeyRound, MonitorSmartphone, Sparkles, User } from 'lucide-react';

import { getUserInitials } from '@/components/layout/app-top-bar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { PublicUserProfile } from '@/modules/auth/session.service';

export interface AuthenticatedHomeProps {
  readonly user: PublicUserProfile;
}

export function AuthenticatedHome({ user }: AuthenticatedHomeProps) {
  const initials = getUserInitials(user.fullName);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-6">
        <Card className="shadow-sm">
          <CardContent className="flex flex-col gap-4 pt-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4">
              <div
                aria-hidden="true"
                className="flex size-14 shrink-0 items-center justify-center rounded-full bg-primary text-lg font-bold text-primary-foreground"
              >
                {initials}
              </div>
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground">Chào mừng trở lại</p>
                <h1 className="truncate text-2xl font-bold tracking-tight text-foreground">
                  {user.fullName}
                </h1>
                <p className="truncate text-sm text-muted-foreground">@{user.username}</p>
              </div>
            </div>

            <Button asChild variant="outline" size="sm" className="w-fit shrink-0">
              <Link href="/settings/account">
                Quản lý tài khoản
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </Button>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Sparkles className="size-5 text-primary" aria-hidden="true" />
              <CardTitle className="text-lg">Bảng tin của bạn</CardTitle>
            </div>
            <CardDescription>Kết nối và khám phá cùng nhau trên TOMATO.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-xl border border-dashed bg-muted/30 px-6 py-10 text-center">
              <p className="text-base font-medium text-foreground">
                Bảng tin đang sẵn sàng cho những kết nối đầu tiên
              </p>
              <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
                Không gian chia sẻ bài viết, theo dõi bạn bè và khám phá cộng đồng sẽ sớm xuất hiện
                tại đây. Trong lúc chờ đợi, bạn có thể kiểm tra thông tin cá nhân và thiết bị đăng
                nhập của mình.
              </p>
              <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
                <Button asChild size="sm">
                  <Link href="/settings/account">Xem tài khoản</Link>
                </Button>
                <Button asChild variant="outline" size="sm">
                  <Link href="/settings/devices">Kiểm tra thiết bị đăng nhập</Link>
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <aside className="space-y-4">
        <Card className="shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Lối tắt tài khoản</CardTitle>
            <CardDescription>Quản lý nhanh thông tin và an toàn tài khoản.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5">
            <Link
              href="/settings/account"
              className="flex items-center justify-between rounded-lg border px-3 py-2.5 text-sm transition-colors hover:bg-muted/60"
            >
              <span className="flex items-center gap-2.5 font-medium text-foreground">
                <User className="size-4 text-primary" aria-hidden="true" />
                Tổng quan tài khoản
              </span>
              <ArrowRight className="size-4 text-muted-foreground" aria-hidden="true" />
            </Link>

            <Link
              href="/settings/security"
              className="flex items-center justify-between rounded-lg border px-3 py-2.5 text-sm transition-colors hover:bg-muted/60"
            >
              <span className="flex items-center gap-2.5 font-medium text-foreground">
                <KeyRound className="size-4 text-primary" aria-hidden="true" />
                Mật khẩu &amp; Bảo mật
              </span>
              <ArrowRight className="size-4 text-muted-foreground" aria-hidden="true" />
            </Link>

            <Link
              href="/settings/devices"
              className="flex items-center justify-between rounded-lg border px-3 py-2.5 text-sm transition-colors hover:bg-muted/60"
            >
              <span className="flex items-center gap-2.5 font-medium text-foreground">
                <MonitorSmartphone className="size-4 text-primary" aria-hidden="true" />
                Thiết bị đăng nhập
              </span>
              <ArrowRight className="size-4 text-muted-foreground" aria-hidden="true" />
            </Link>
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}
