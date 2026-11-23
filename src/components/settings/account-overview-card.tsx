import Link from 'next/link';
import { ArrowRight, CheckCircle2, KeyRound, MonitorSmartphone, Pencil } from 'lucide-react';

import { UserAvatar } from '@/components/profile/user-avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { PublicUserProfile } from '@/modules/auth/session.service';

export interface AccountOverviewCardProps {
  readonly user: PublicUserProfile;
  readonly avatarUrl?: string | null;
}

function formatVietnameseGender(gender: PublicUserProfile['gender']): string {
  switch (gender) {
    case 'male':
      return 'Nam';
    case 'female':
      return 'Nữ';
    case 'other':
      return 'Khác';
  }
}

function formatVietnameseAccountStatus(status: PublicUserProfile['status']): string {
  switch (status) {
    case 'active':
      return 'Đang hoạt động';
    case 'pending_verification':
      return 'Chờ xác minh email';
    case 'locked':
      return 'Đang tạm khóa';
    case 'suspended':
      return 'Đang tạm đình chỉ';
    case 'deleted':
      return 'Đã đóng';
  }
}

export function AccountOverviewCard({ user, avatarUrl = null }: AccountOverviewCardProps) {
  return (
    <div className="space-y-6">
      <Card className="shadow-sm">
        <CardHeader className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-lg">Tổng quan tài khoản</CardTitle>
            <CardDescription>
              Thông tin cơ bản hiển thị trên tài khoản Tomato của bạn.
            </CardDescription>
          </div>
          <Button asChild variant="outline" size="sm" className="w-fit shrink-0">
            <Link href="/settings/profile">
              <Pencil className="size-3.5" aria-hidden="true" />
              <span>Chỉnh sửa hồ sơ</span>
            </Link>
          </Button>
        </CardHeader>

        <CardContent className="space-y-6 pt-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4">
              <UserAvatar fullName={user.fullName} avatarUrl={avatarUrl} size="lg" />
              <div className="min-w-0">
                <p className="truncate text-lg font-semibold text-foreground">{user.fullName}</p>
                <p className="truncate text-sm text-muted-foreground">@{user.username}</p>
              </div>
            </div>

            <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-emerald-600/30 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-800">
              <CheckCircle2 className="size-3.5" aria-hidden="true" />
              {formatVietnameseAccountStatus(user.status)}
            </span>
          </div>

          <dl className="divide-y rounded-xl border bg-muted/20">
            <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <dt className="text-sm text-muted-foreground">Họ và tên</dt>
              <dd className="text-sm font-medium text-foreground">{user.fullName}</dd>
            </div>
            <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <dt className="text-sm text-muted-foreground">ID tài khoản</dt>
              <dd className="text-sm font-medium text-foreground">@{user.username}</dd>
            </div>
            <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <dt className="text-sm text-muted-foreground">Giới tính</dt>
              <dd className="text-sm font-medium text-foreground">
                {formatVietnameseGender(user.gender)}
              </dd>
            </div>
            <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <dt className="text-sm text-muted-foreground">Trạng thái tài khoản</dt>
              <dd className="text-sm font-medium text-emerald-700">
                {formatVietnameseAccountStatus(user.status)}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="shadow-sm">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <KeyRound className="size-4 text-primary" aria-hidden="true" />
              <CardTitle className="text-base">Mật khẩu &amp; Bảo mật</CardTitle>
            </div>
            <CardDescription>Cập nhật mật khẩu mới với xác nhận 2 bước qua email.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline" size="sm" className="w-full justify-between">
              <Link href="/settings/security">
                <span>Đổi mật khẩu</span>
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </Button>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <MonitorSmartphone className="size-4 text-primary" aria-hidden="true" />
              <CardTitle className="text-base">Thiết bị đăng nhập</CardTitle>
            </div>
            <CardDescription>
              Xem thiết bị đang hoạt động và lịch sử đăng nhập gần đây.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline" size="sm" className="w-full justify-between">
              <Link href="/settings/devices">
                <span>Quản lý thiết bị</span>
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
