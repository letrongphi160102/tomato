'use client';

import * as React from 'react';
import Link from 'next/link';
import { Loader2, Search, Users, X } from 'lucide-react';

import { UserAvatar } from '@/components/profile/user-avatar';
import { ConfirmDialog } from '@/components/social/confirm-dialog';
import { Button } from '@/components/ui/button';
import { authFetch } from '@/lib/auth-client';
import type { SocialFollowStatus } from '@/modules/social/social.policy';
import type { SocialUserListItemDto } from '@/modules/social/social.service';

export type FollowListType = 'followers' | 'following';

export interface FollowListModalProps {
  readonly open: boolean;
  readonly listType: FollowListType;
  readonly targetPublicId: string;
  readonly isOwnProfile: boolean;
  readonly onClose: () => void;
  readonly onFollowerRemoved?: (nextFollowersCount: number) => void;
  readonly onOwnFollowingCountChanged?: (nextFollowingCount: number) => void;
}

const LIST_SEARCH_DEBOUNCE_MS = 260;

type FollowListDialogBodyProps = Omit<FollowListModalProps, 'open'>;

function FollowListDialogBody({
  listType,
  targetPublicId,
  isOwnProfile,
  onClose,
  onFollowerRemoved,
  onOwnFollowingCountChanged,
}: FollowListDialogBodyProps) {
  const titleId = React.useId();
  const searchInputId = React.useId();

  const [query, setQuery] = React.useState('');
  const [items, setItems] = React.useState<readonly SocialUserListItemDto[]>([]);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [busyIds, setBusyIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const [confirmRemoveTarget, setConfirmRemoveTarget] =
    React.useState<SocialUserListItemDto | null>(null);
  const [removingFollower, setRemovingFollower] = React.useState(false);
  const loadMoreControllerRef = React.useRef<AbortController | null>(null);
  const [removeError, setRemoveError] = React.useState<string | null>(null);

  const trimmedQuery = query.trim();
  const endpointBase = `/api/v1/social/users/${encodeURIComponent(targetPublicId)}/${listType}`;

  React.useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !confirmRemoveTarget) {
        onClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [confirmRemoveTarget, onClose]);

  React.useEffect(() => {
    const controller = new AbortController();
    const delayMs = trimmedQuery.length > 0 ? LIST_SEARCH_DEBOUNCE_MS : 0;

    const timer = window.setTimeout(async () => {
      setLoading(true);
      setErrorMessage(null);

      try {
        const params = new URLSearchParams({ limit: '20' });
        if (trimmedQuery.length > 0) {
          params.set('q', trimmedQuery);
        }
        const response = await authFetch(`${endpointBase}?${params.toString()}`, {
          method: 'GET',
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          return;
        }
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            readonly error?: { readonly message?: string };
          } | null;
          setItems([]);
          setNextCursor(null);
          setErrorMessage(body?.error?.message ?? 'Không thể tải danh sách lúc này.');
          return;
        }

        const data = (await response.json()) as {
          readonly items?: SocialUserListItemDto[];
          readonly nextCursor?: string | null;
        };
        setItems(Array.isArray(data.items) ? data.items : []);
        setNextCursor(typeof data.nextCursor === 'string' ? data.nextCursor : null);
      } catch {
        if (!controller.signal.aborted) {
          setItems([]);
          setNextCursor(null);
          setErrorMessage('Không thể kết nối. Vui lòng thử lại.');
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }, delayMs);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
      loadMoreControllerRef.current?.abort();
      loadMoreControllerRef.current = null;
    };
  }, [endpointBase, trimmedQuery]);

  async function handleLoadMore() {
    if (!nextCursor || loadingMore) {
      return;
    }
    loadMoreControllerRef.current?.abort();
    const controller = new AbortController();
    loadMoreControllerRef.current = controller;

    setLoadingMore(true);
    setErrorMessage(null);
    try {
      const params = new URLSearchParams({ limit: '20', cursor: nextCursor });
      if (trimmedQuery.length > 0) {
        params.set('q', trimmedQuery);
      }
      const response = await authFetch(`${endpointBase}?${params.toString()}`, {
        method: 'GET',
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        return;
      }
      if (!response.ok) {
        setErrorMessage('Không thể tải thêm danh sách. Vui lòng thử lại.');
        return;
      }
      const data = (await response.json()) as {
        readonly items?: SocialUserListItemDto[];
        readonly nextCursor?: string | null;
      };
      if (controller.signal.aborted) {
        return;
      }
      const incoming = Array.isArray(data.items) ? data.items : [];
      setItems((prev) => {
        const seen = new Set(prev.map((item) => item.public_id));
        const merged = [...prev];
        for (const item of incoming) {
          if (!seen.has(item.public_id)) {
            seen.add(item.public_id);
            merged.push(item);
          }
        }
        return merged;
      });
      setNextCursor(typeof data.nextCursor === 'string' ? data.nextCursor : null);
    } catch {
      if (!controller.signal.aborted) {
        setErrorMessage('Không thể kết nối. Vui lòng thử lại.');
      }
    } finally {
      if (loadMoreControllerRef.current === controller) {
        loadMoreControllerRef.current = null;
      }
      if (!controller.signal.aborted) {
        setLoadingMore(false);
      }
    }
  }

  async function handleToggleFollow(item: SocialUserListItemDto) {
    if (busyIds.has(item.public_id)) {
      return;
    }
    const previousStatus = item.followStatus;
    const isCurrentlyConnected = previousStatus === 'following' || previousStatus === 'requested';
    const optimisticStatus: SocialFollowStatus = isCurrentlyConnected
      ? 'none'
      : item.isPrivate
        ? 'requested'
        : 'following';

    setBusyIds((prev) => new Set(prev).add(item.public_id));
    setItems((prev) =>
      prev.map((entry) =>
        entry.public_id === item.public_id ? { ...entry, followStatus: optimisticStatus } : entry,
      ),
    );
    setErrorMessage(null);

    try {
      const response = await authFetch(
        `/api/v1/social/follow/${encodeURIComponent(item.public_id)}`,
        {
          method: isCurrentlyConnected ? 'DELETE' : 'POST',
        },
      );

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          readonly error?: { readonly message?: string };
        } | null;
        throw new Error(body?.error?.message ?? 'Không thể cập nhật trạng thái theo dõi.');
      }

      const data = (await response.json()) as {
        readonly followStatus: SocialFollowStatus;
        readonly followingCount: number;
      };

      setItems((prev) =>
        prev.map((entry) =>
          entry.public_id === item.public_id
            ? { ...entry, followStatus: data.followStatus }
            : entry,
        ),
      );
      if (isOwnProfile) {
        onOwnFollowingCountChanged?.(data.followingCount);
      }
    } catch (error) {
      setItems((prev) =>
        prev.map((entry) =>
          entry.public_id === item.public_id ? { ...entry, followStatus: previousStatus } : entry,
        ),
      );
      setErrorMessage(
        error instanceof Error ? error.message : 'Không thể cập nhật trạng thái theo dõi.',
      );
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(item.public_id);
        return next;
      });
    }
  }

  async function handleConfirmRemoveFollower() {
    if (!confirmRemoveTarget || removingFollower) {
      return;
    }
    setRemovingFollower(true);
    setRemoveError(null);
    try {
      const response = await authFetch(
        `/api/v1/social/followers/${encodeURIComponent(confirmRemoveTarget.public_id)}`,
        { method: 'DELETE' },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          readonly error?: { readonly message?: string };
        } | null;
        setRemoveError(body?.error?.message ?? 'Không thể gỡ người theo dõi này.');
        return;
      }
      const data = (await response.json()) as { readonly followersCount: number };
      setItems((prev) => prev.filter((item) => item.public_id !== confirmRemoveTarget.public_id));
      onFollowerRemoved?.(data.followersCount);
      setConfirmRemoveTarget(null);
    } catch {
      setRemoveError('Không thể kết nối. Vui lòng thử lại.');
    } finally {
      setRemovingFollower(false);
    }
  }

  const modalTitle = listType === 'followers' ? 'Người theo dõi' : 'Đang theo dõi';

  return (
    <>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            onClose();
          }
        }}
      >
        <div className="flex max-h-[82vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl">
          <div className="flex items-center justify-between border-b px-5 py-3.5">
            <h2 id={titleId} className="text-base font-semibold text-foreground">
              {modalTitle}
            </h2>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Đóng danh sách"
              onClick={onClose}
              className="size-8 rounded-full"
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>

          <div className="border-b px-4 py-3">
            <div className="relative flex items-center">
              <Search
                className="pointer-events-none absolute left-3 size-4 text-muted-foreground"
                aria-hidden="true"
              />
              <input
                id={searchInputId}
                name="followListSearch"
                type="search"
                autoComplete="off"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Tìm kiếm trong danh sách..."
                aria-label="Tìm kiếm trong danh sách"
                className="h-9 w-full rounded-xl border border-border/80 bg-muted/40 pl-9 pr-8 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary/40 focus:bg-background focus:outline-none focus:ring-2 focus:ring-primary/15 [&::-webkit-search-cancel-button]:hidden"
              />
              {query.length > 0 ? (
                <button
                  type="button"
                  aria-label="Xóa từ khóa tìm kiếm"
                  onClick={() => setQuery('')}
                  className="absolute right-2.5 flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              ) : null}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-2">
            {errorMessage ? (
              <p
                role="alert"
                className="px-3 py-2 text-center text-xs font-medium text-destructive"
              >
                {errorMessage}
              </p>
            ) : null}

            {loading ? (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
                <span>Đang tải danh sách...</span>
              </div>
            ) : items.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Users className="size-5" aria-hidden="true" />
                </div>
                <p className="mt-3 text-sm font-medium text-foreground">
                  {trimmedQuery
                    ? 'Không tìm thấy tài khoản phù hợp.'
                    : listType === 'followers'
                      ? 'Chưa có người theo dõi nào.'
                      : 'Chưa theo dõi tài khoản nào.'}
                </p>
              </div>
            ) : (
              <ul className="space-y-1">
                {items.map((item) => {
                  const isBusy = busyIds.has(item.public_id);
                  const followButtonLabel =
                    item.followStatus === 'following'
                      ? 'Đang theo dõi'
                      : item.followStatus === 'requested'
                        ? 'Đã gửi yêu cầu'
                        : item.followedBy
                          ? 'Theo dõi lại'
                          : 'Theo dõi';

                  return (
                    <li
                      key={item.public_id}
                      className="flex items-center justify-between gap-3 rounded-xl px-2.5 py-2 transition-colors hover:bg-muted/50"
                    >
                      <Link
                        href={`/u/${encodeURIComponent(item.handle)}`}
                        onClick={onClose}
                        className="flex min-w-0 flex-1 items-center gap-3"
                      >
                        <UserAvatar fullName={item.fullName} avatarUrl={item.avatarUrl} size="sm" />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-foreground">
                            @{item.handle}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">{item.fullName}</p>
                        </div>
                      </Link>

                      {item.isOwnProfile ? null : isOwnProfile && listType === 'followers' ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setRemoveError(null);
                            setConfirmRemoveTarget(item);
                          }}
                          className="h-8 shrink-0 rounded-lg px-3 text-xs"
                        >
                          Gỡ
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          variant={item.followStatus === 'none' ? 'default' : 'outline'}
                          size="sm"
                          disabled={isBusy}
                          onClick={() => void handleToggleFollow(item)}
                          className="h-8 shrink-0 rounded-lg px-3 text-xs"
                        >
                          {isBusy ? (
                            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                          ) : (
                            <span>{followButtonLabel}</span>
                          )}
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {nextCursor && !loading ? (
              <div className="py-3 text-center">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={loadingMore}
                  onClick={() => void handleLoadMore()}
                >
                  {loadingMore ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                      <span>Đang tải thêm...</span>
                    </>
                  ) : (
                    <span>Tải thêm</span>
                  )}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmRemoveTarget !== null}
        title="Gỡ người theo dõi?"
        description={
          confirmRemoveTarget
            ? `Tomato sẽ không thông báo cho @${confirmRemoveTarget.handle} biết rằng họ đã bị gỡ khỏi danh sách người theo dõi của bạn.`
            : ''
        }
        confirmLabel="Gỡ"
        destructive
        loading={removingFollower}
        errorMessage={removeError}
        onClose={() => {
          if (!removingFollower) {
            setConfirmRemoveTarget(null);
            setRemoveError(null);
          }
        }}
        onConfirm={handleConfirmRemoveFollower}
      />
    </>
  );
}

export function FollowListModal({ open, ...rest }: FollowListModalProps) {
  if (!open) {
    return null;
  }

  return <FollowListDialogBody key={`${rest.targetPublicId}:${rest.listType}`} {...rest} />;
}
