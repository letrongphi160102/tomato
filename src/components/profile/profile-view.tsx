import Link from 'next/link';
import { Camera, Grid3X3, Lock, Pencil } from 'lucide-react';

import { UserAvatar } from '@/components/profile/user-avatar';
import { Button } from '@/components/ui/button';
import type { UserProfileDto } from '@/modules/profile';

export interface ProfileViewProps {
  readonly profile: UserProfileDto;
}

function formatCompactCount(value: number): string {
  return new Intl.NumberFormat('vi-VN').format(value);
}

export function ProfileView({ profile }: ProfileViewProps) {
  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <section
        aria-label="Thông tin trang cá nhân"
        className="rounded-2xl border bg-background p-6 shadow-sm sm:p-8"
      >
        <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start sm:gap-10">
          <div className="shrink-0">
            <UserAvatar
              fullName={profile.fullName}
              avatarUrl={profile.avatarUrl}
              size="2xl"
              className="ring-2 ring-border/80"
            />
          </div>

          <div className="flex min-w-0 flex-1 flex-col items-center text-center sm:items-start sm:text-left">
            <div className="flex flex-wrap items-center justify-center gap-3 sm:justify-start">
              <h1 className="truncate text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
                @{profile.handle}
              </h1>

              {profile.isPrivate ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                  <Lock className="size-3" aria-hidden="true" />
                  Riêng tư
                </span>
              ) : null}

              {profile.isOwnProfile ? (
                <Button asChild variant="outline" size="sm" className="h-8 rounded-lg">
                  <Link href="/settings/profile">
                    <Pencil className="size-3.5" aria-hidden="true" />
                    <span>Chỉnh sửa hồ sơ</span>
                  </Link>
                </Button>
              ) : null}
            </div>

            <dl className="mt-4 flex items-center gap-6 text-sm sm:gap-8">
              <div className="flex items-baseline gap-1.5">
                <dt className="order-2 text-muted-foreground">Người theo dõi</dt>
                <dd className="order-1 text-base font-semibold text-foreground">
                  {formatCompactCount(profile.followersCount)}
                </dd>
              </div>
              <div className="flex items-baseline gap-1.5">
                <dt className="order-2 text-muted-foreground">Đang theo dõi</dt>
                <dd className="order-1 text-base font-semibold text-foreground">
                  {formatCompactCount(profile.followingCount)}
                </dd>
              </div>
            </dl>

            <div className="mt-4 max-w-xl space-y-1.5">
              <p className="text-sm font-semibold text-foreground sm:text-base">
                {profile.fullName}
              </p>
              {profile.bio ? (
                <p className="whitespace-pre-line break-words text-sm leading-relaxed text-foreground/90">
                  {profile.bio}
                </p>
              ) : profile.isOwnProfile ? (
                <p className="text-sm text-muted-foreground">
                  Thêm một vài dòng giới thiệu về bản thân bạn.
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <section aria-label="Bài viết" className="space-y-4">
        <div className="flex items-center justify-center border-t pt-3">
          <div className="inline-flex items-center gap-2 border-t-2 border-foreground pt-2 text-xs font-semibold uppercase tracking-wider text-foreground">
            <Grid3X3 className="size-3.5" aria-hidden="true" />
            <span>Bài viết</span>
          </div>
        </div>

        <div className="rounded-2xl border border-dashed bg-background/80 px-6 py-14 text-center">
          <div className="mx-auto flex size-14 items-center justify-center rounded-full border bg-muted/40 text-muted-foreground">
            <Camera className="size-6" aria-hidden="true" />
          </div>
          <h2 className="mt-4 text-base font-semibold text-foreground">Chưa có bài viết nào</h2>
          <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted-foreground">
            {profile.isOwnProfile
              ? 'Khi bạn chia sẻ ảnh và khoảnh khắc trên Tomato, chúng sẽ xuất hiện tại đây.'
              : 'Trang cá nhân này chưa chia sẻ bài viết nào.'}
          </p>
        </div>
      </section>
    </div>
  );
}
