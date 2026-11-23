'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Ban,
  Camera,
  Grid3X3,
  Loader2,
  Lock,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Shield,
  UserCheck,
  UserPlus,
  UserX,
} from 'lucide-react';

import { UserAvatar } from '@/components/profile/user-avatar';
import { useRealtimePresence } from '@/components/realtime/realtime-presence-context';
import { ConfirmDialog } from '@/components/social/confirm-dialog';
import { FollowListModal, type FollowListType } from '@/components/social/follow-list-modal';
import { FollowRequestsModal } from '@/components/social/follow-requests-modal';
import { Button } from '@/components/ui/button';
import { authFetch } from '@/lib/auth-client';
import type { PresenceStatusDto } from '@/modules/presence/presence.service';
import type { UserProfileDto } from '@/modules/profile';
import type { SocialFollowStatus } from '@/modules/social/social.policy';

export interface ProfileViewProps {
  readonly initialProfile: UserProfileDto;
  readonly initialPendingRequestsCount?: number;
}

function formatCompactCount(value: number): string {
  return new Intl.NumberFormat('vi-VN').format(value);
}

export function ProfileView({ initialProfile, initialPendingRequestsCount = 0 }: ProfileViewProps) {
  const realtime = useRealtimePresence();
  const [profile, setProfile] = React.useState<UserProfileDto>(initialProfile);
  const [presence, setPresence] = React.useState<PresenceStatusDto | null>(null);
  const [pendingRequestsCount, setPendingRequestsCount] = React.useState<number>(
    initialPendingRequestsCount,
  );
  const [followLoading, setFollowLoading] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [confirmUnfollowOpen, setConfirmUnfollowOpen] = React.useState(false);
  const [confirmBlockOpen, setConfirmBlockOpen] = React.useState(false);
  const [blocking, setBlocking] = React.useState(false);
  const [blockError, setBlockError] = React.useState<string | null>(null);
  const [blockedLocally, setBlockedLocally] = React.useState(false);
  const [activeListModal, setActiveListModal] = React.useState<FollowListType | null>(null);
  const [requestsModalOpen, setRequestsModalOpen] = React.useState(false);

  const menuRef = React.useRef<HTMLDivElement | null>(null);

  const isMutualFollow =
    !profile.isOwnProfile && profile.followStatus === 'following' && profile.followedBy;
  const viewerActiveStatusEnabled = realtime?.activeStatusEnabled ?? true;
  const canDisplayPresence = isMutualFollow && viewerActiveStatusEnabled && !blockedLocally;
  const effectivePresence = canDisplayPresence ? presence : null;

  React.useEffect(() => {
    if (!canDisplayPresence) {
      return;
    }

    const controller = new AbortController();

    void authFetch('/api/v1/presence/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userPublicIds: [profile.public_id] }),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (controller.signal.aborted || !response.ok) {
          return;
        }
        const data = (await response.json()) as {
          readonly presences?: Record<string, PresenceStatusDto | null>;
        };
        const status = data.presences?.[profile.public_id.toLowerCase()] ?? null;
        setPresence(status);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setPresence(null);
        }
      });

    return () => controller.abort();
  }, [canDisplayPresence, profile.public_id]);

  React.useEffect(() => {
    if (!menuOpen) {
      return;
    }
    function handlePointerDown(event: MouseEvent) {
      if (
        menuRef.current &&
        event.target instanceof Node &&
        !menuRef.current.contains(event.target)
      ) {
        setMenuOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

  async function executeFollowMutation(method: 'POST' | 'DELETE') {
    if (followLoading) {
      return;
    }
    const previous = profile;
    const optimisticStatus: SocialFollowStatus =
      method === 'DELETE' ? 'none' : profile.isPrivate ? 'requested' : 'following';

    const followersDelta =
      method === 'POST' && !profile.isPrivate && profile.followStatus !== 'following'
        ? 1
        : method === 'DELETE' && profile.followStatus === 'following'
          ? -1
          : 0;

    setFollowLoading(true);
    setActionError(null);
    setProfile((prev) => ({
      ...prev,
      followStatus: optimisticStatus,
      followersCount: Math.max(0, prev.followersCount + followersDelta),
      canViewConnections: prev.isOwnProfile || !prev.isPrivate || optimisticStatus === 'following',
    }));

    try {
      const response = await authFetch(
        `/api/v1/social/follow/${encodeURIComponent(profile.public_id)}`,
        { method },
      );

      if (!response.ok) {
        if (response.status === 404) {
          setBlockedLocally(true);
          return;
        }
        const body = (await response.json().catch(() => null)) as {
          readonly error?: { readonly message?: string };
        } | null;
        throw new Error(body?.error?.message ?? 'Không thể cập nhật trạng thái theo dõi.');
      }

      const data = (await response.json()) as {
        readonly followStatus: SocialFollowStatus;
        readonly followersCount: number;
      };

      setProfile((prev) => ({
        ...prev,
        followStatus: data.followStatus,
        followersCount: data.followersCount,
        canViewConnections:
          prev.isOwnProfile || !prev.isPrivate || data.followStatus === 'following',
      }));
      setConfirmUnfollowOpen(false);
    } catch (error) {
      setProfile(previous);
      setActionError(
        error instanceof Error ? error.message : 'Không thể cập nhật trạng thái theo dõi.',
      );
    } finally {
      setFollowLoading(false);
    }
  }

  function handlePrimaryFollowClick() {
    if (profile.followStatus === 'none') {
      void executeFollowMutation('POST');
      return;
    }
    if (profile.followStatus === 'requested') {
      void executeFollowMutation('DELETE');
      return;
    }
    // Đang theo dõi tài khoản riêng tư -> hiển thị xác nhận nhẹ để tránh bỏ theo dõi nhầm.
    if (profile.isPrivate) {
      setConfirmUnfollowOpen(true);
      return;
    }
    void executeFollowMutation('DELETE');
  }

  async function handleConfirmBlock() {
    if (blocking) {
      return;
    }
    setBlocking(true);
    setBlockError(null);

    try {
      const response = await authFetch(
        `/api/v1/social/blocks/${encodeURIComponent(profile.public_id)}`,
        { method: 'POST' },
      );

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          readonly error?: { readonly message?: string };
        } | null;
        setBlockError(body?.error?.message ?? 'Không thể chặn tài khoản này lúc này.');
        return;
      }

      setConfirmBlockOpen(false);
      setBlockedLocally(true);
    } catch {
      setBlockError('Không thể kết nối. Vui lòng thử lại.');
    } finally {
      setBlocking(false);
    }
  }

  if (blockedLocally) {
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

  const followButtonLabel =
    profile.followStatus === 'following'
      ? 'Đang theo dõi'
      : profile.followStatus === 'requested'
        ? 'Đã gửi yêu cầu'
        : profile.followedBy
          ? 'Theo dõi lại'
          : 'Theo dõi';

  return (
    <>
      <div className="mx-auto max-w-4xl space-y-8">
        <section
          aria-label="Thông tin trang cá nhân"
          className="rounded-2xl border bg-background p-6 shadow-sm sm:p-8"
        >
          <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start sm:gap-10">
            <div className="relative shrink-0">
              <UserAvatar
                fullName={profile.fullName}
                avatarUrl={profile.avatarUrl}
                size="2xl"
                className="ring-2 ring-border/80"
              />
              {effectivePresence?.isOnline ? (
                <span
                  aria-hidden="true"
                  className="absolute bottom-1.5 right-1.5 size-4 rounded-full bg-emerald-500 ring-2 ring-background"
                />
              ) : null}
            </div>

            <div className="flex min-w-0 flex-1 flex-col items-center text-center sm:items-start sm:text-left">
              <div className="flex flex-wrap items-center justify-center gap-2.5 sm:justify-start">
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
                  <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
                    <Button asChild variant="outline" size="sm" className="h-8 rounded-lg">
                      <Link href="/settings/profile">
                        <Pencil className="size-3.5" aria-hidden="true" />
                        <span>Chỉnh sửa hồ sơ</span>
                      </Link>
                    </Button>
                    <Button asChild variant="outline" size="sm" className="h-8 rounded-lg">
                      <Link href="/settings/privacy">
                        <Shield className="size-3.5" aria-hidden="true" />
                        <span>Quyền riêng tư</span>
                      </Link>
                    </Button>
                    {pendingRequestsCount > 0 ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => setRequestsModalOpen(true)}
                        className="h-8 rounded-lg"
                      >
                        <UserPlus className="size-3.5" aria-hidden="true" />
                        <span>Yêu cầu theo dõi</span>
                        <span className="ml-0.5 inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground">
                          {pendingRequestsCount}
                        </span>
                      </Button>
                    ) : null}
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant={profile.followStatus === 'none' ? 'default' : 'outline'}
                      size="sm"
                      disabled={followLoading}
                      onClick={handlePrimaryFollowClick}
                      className="h-8 min-w-[116px] rounded-lg"
                    >
                      {followLoading ? (
                        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                      ) : profile.followStatus === 'following' ? (
                        <>
                          <UserCheck className="size-3.5" aria-hidden="true" />
                          <span>{followButtonLabel}</span>
                        </>
                      ) : (
                        <span>{followButtonLabel}</span>
                      )}
                    </Button>

                    <Button asChild variant="outline" size="sm" className="h-8 rounded-lg">
                      <Link
                        href={`/messages?to=${encodeURIComponent(profile.public_id)}&handle=${encodeURIComponent(profile.handle)}`}
                      >
                        <MessageCircle className="size-3.5" aria-hidden="true" />
                        <span>Nhắn tin</span>
                      </Link>
                    </Button>

                    <div ref={menuRef} className="relative">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Tùy chọn khác"
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                        onClick={() => setMenuOpen((prev) => !prev)}
                        className="size-8 rounded-lg"
                      >
                        <MoreHorizontal className="size-4" aria-hidden="true" />
                      </Button>

                      {menuOpen ? (
                        <div
                          role="menu"
                          aria-label="Tùy chọn tài khoản"
                          className="absolute right-0 z-30 mt-1.5 w-44 origin-top-right rounded-xl border bg-background p-1 shadow-lg"
                        >
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setMenuOpen(false);
                              setBlockError(null);
                              setConfirmBlockOpen(true);
                            }}
                            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium text-destructive transition-colors hover:bg-destructive/10"
                          >
                            <Ban className="size-4" aria-hidden="true" />
                            <span>Chặn</span>
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                )}
              </div>

              {actionError ? (
                <p role="alert" className="mt-2 text-xs font-medium text-destructive">
                  {actionError}
                </p>
              ) : null}

              <dl className="mt-4 flex items-center gap-6 text-sm sm:gap-8">
                {profile.canViewConnections ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setActiveListModal('followers')}
                      className="group flex items-baseline gap-1.5 rounded-md px-1 py-0.5 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <dt className="order-2 text-muted-foreground group-hover:text-foreground">
                        Người theo dõi
                      </dt>
                      <dd className="order-1 text-base font-semibold text-foreground">
                        {formatCompactCount(profile.followersCount)}
                      </dd>
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveListModal('following')}
                      className="group flex items-baseline gap-1.5 rounded-md px-1 py-0.5 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <dt className="order-2 text-muted-foreground group-hover:text-foreground">
                        Đang theo dõi
                      </dt>
                      <dd className="order-1 text-base font-semibold text-foreground">
                        {formatCompactCount(profile.followingCount)}
                      </dd>
                    </button>
                  </>
                ) : (
                  <>
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
                  </>
                )}
              </dl>

              <div className="mt-4 max-w-xl space-y-1.5">
                <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
                  <p className="text-sm font-semibold text-foreground sm:text-base">
                    {profile.fullName}
                  </p>
                  {effectivePresence ? (
                    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                      {effectivePresence.isOnline ? (
                        <span aria-hidden="true" className="size-2 rounded-full bg-emerald-500" />
                      ) : null}
                      <span>{effectivePresence.label}</span>
                    </span>
                  ) : null}
                </div>
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

        {profile.isPrivate && !profile.canViewConnections ? (
          <section aria-label="Tài khoản riêng tư">
            <div className="rounded-2xl border bg-background px-6 py-14 text-center shadow-sm">
              <div className="mx-auto flex size-14 items-center justify-center rounded-full border-2 border-border bg-muted/40 text-foreground">
                <Lock className="size-6" aria-hidden="true" />
              </div>
              <h2 className="mt-4 text-base font-semibold text-foreground">
                Đây là tài khoản riêng tư
              </h2>
              <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted-foreground">
                Hãy theo dõi tài khoản này để xem hoạt động và kết nối với họ trên Tomato.
              </p>
            </div>
          </section>
        ) : (
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
        )}
      </div>

      <FollowListModal
        open={activeListModal !== null}
        listType={activeListModal ?? 'followers'}
        targetPublicId={profile.public_id}
        isOwnProfile={profile.isOwnProfile}
        onClose={() => setActiveListModal(null)}
        onFollowerRemoved={(nextFollowersCount) => {
          setProfile((prev) => ({ ...prev, followersCount: nextFollowersCount }));
        }}
        onOwnFollowingCountChanged={(nextFollowingCount) => {
          setProfile((prev) => ({ ...prev, followingCount: nextFollowingCount }));
        }}
      />

      {profile.isOwnProfile ? (
        <FollowRequestsModal
          open={requestsModalOpen}
          onClose={() => setRequestsModalOpen(false)}
          onAccepted={(nextFollowersCount) => {
            setPendingRequestsCount((prev) => Math.max(0, prev - 1));
            if (typeof nextFollowersCount === 'number') {
              setProfile((prev) => ({ ...prev, followersCount: nextFollowersCount }));
            }
          }}
          onDeclined={() => {
            setPendingRequestsCount((prev) => Math.max(0, prev - 1));
          }}
        />
      ) : null}

      <ConfirmDialog
        open={confirmUnfollowOpen}
        title={`Bỏ theo dõi @${profile.handle}?`}
        description="Nếu đổi ý sau này, bạn sẽ cần gửi lại yêu cầu theo dõi tài khoản riêng tư này."
        confirmLabel="Bỏ theo dõi"
        destructive
        loading={followLoading}
        onClose={() => setConfirmUnfollowOpen(false)}
        onConfirm={() => executeFollowMutation('DELETE')}
      />

      <ConfirmDialog
        open={confirmBlockOpen}
        title={`Chặn @${profile.handle}?`}
        description="Người này sẽ không thể tìm thấy trang cá nhân hay kết nối với bạn trên Tomato. Họ sẽ không nhận được thông báo khi bị chặn."
        confirmLabel="Chặn"
        destructive
        loading={blocking}
        errorMessage={blockError}
        onClose={() => {
          if (!blocking) {
            setConfirmBlockOpen(false);
            setBlockError(null);
          }
        }}
        onConfirm={handleConfirmBlock}
      />
    </>
  );
}
