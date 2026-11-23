'use client';

import * as React from 'react';
import Link from 'next/link';
import { Loader2, UserPlus, X } from 'lucide-react';

import { UserAvatar } from '@/components/profile/user-avatar';
import { Button } from '@/components/ui/button';
import { authFetch } from '@/lib/auth-client';
import type { SocialFollowRequestItemDto } from '@/modules/social/social.service';

export interface FollowRequestsModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onAccepted?: (nextFollowersCount?: number) => void;
  readonly onDeclined?: () => void;
}

type FollowRequestsDialogBodyProps = Omit<FollowRequestsModalProps, 'open'>;

function FollowRequestsDialogBody({
  onClose,
  onAccepted,
  onDeclined,
}: FollowRequestsDialogBodyProps) {
  const titleId = React.useId();

  const [items, setItems] = React.useState<readonly SocialFollowRequestItemDto[]>([]);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [busyIds, setBusyIds] = React.useState<ReadonlySet<string>>(() => new Set());

  React.useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  React.useEffect(() => {
    const controller = new AbortController();

    void authFetch('/api/v1/social/follow-requests?limit=20', {
      method: 'GET',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (controller.signal.aborted) {
          return;
        }
        if (!response.ok) {
          setItems([]);
          setNextCursor(null);
          setErrorMessage('Không thể tải yêu cầu theo dõi lúc này.');
          return;
        }
        const data = (await response.json()) as {
          readonly items?: SocialFollowRequestItemDto[];
          readonly nextCursor?: string | null;
        };
        setItems(Array.isArray(data.items) ? data.items : []);
        setNextCursor(typeof data.nextCursor === 'string' ? data.nextCursor : null);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setItems([]);
          setNextCursor(null);
          setErrorMessage('Không thể kết nối. Vui lòng thử lại.');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, []);

  async function handleLoadMore() {
    if (!nextCursor || loadingMore) {
      return;
    }
    setLoadingMore(true);
    setErrorMessage(null);
    try {
      const params = new URLSearchParams({ limit: '20', cursor: nextCursor });
      const response = await authFetch(`/api/v1/social/follow-requests?${params.toString()}`, {
        method: 'GET',
      });
      if (!response.ok) {
        setErrorMessage('Không thể tải thêm yêu cầu.');
        return;
      }
      const data = (await response.json()) as {
        readonly items?: SocialFollowRequestItemDto[];
        readonly nextCursor?: string | null;
      };
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
      setErrorMessage('Không thể kết nối. Vui lòng thử lại.');
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleDecision(publicId: string, action: 'accept' | 'decline') {
    if (busyIds.has(publicId)) {
      return;
    }
    setBusyIds((prev) => new Set(prev).add(publicId));
    setErrorMessage(null);

    try {
      const response = await authFetch(
        `/api/v1/social/follow-requests/${encodeURIComponent(publicId)}/${action}`,
        { method: 'POST' },
      );

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          readonly error?: { readonly message?: string };
        } | null;
        setErrorMessage(body?.error?.message ?? 'Không thể xử lý yêu cầu này.');
        return;
      }

      const data = (await response.json()) as { readonly followersCount?: number };
      setItems((prev) => prev.filter((item) => item.public_id !== publicId));
      if (action === 'accept') {
        onAccepted?.(data.followersCount);
      } else {
        onDeclined?.();
      }
    } catch {
      setErrorMessage('Không thể kết nối. Vui lòng thử lại.');
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(publicId);
        return next;
      });
    }
  }

  return (
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
            Yêu cầu theo dõi
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Đóng hộp thoại"
            onClick={onClose}
            className="size-8 rounded-full"
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-2">
          {errorMessage ? (
            <p role="alert" className="px-3 py-2 text-center text-xs font-medium text-destructive">
              {errorMessage}
            </p>
          ) : null}

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
              <span>Đang tải yêu cầu...</span>
            </div>
          ) : items.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <UserPlus className="size-5" aria-hidden="true" />
              </div>
              <p className="mt-3 text-sm font-medium text-foreground">
                Không có yêu cầu theo dõi nào đang chờ.
              </p>
            </div>
          ) : (
            <ul className="space-y-1">
              {items.map((item) => {
                const isBusy = busyIds.has(item.public_id);
                return (
                  <li
                    key={item.public_id}
                    className="flex items-center justify-between gap-3 rounded-xl px-2.5 py-2.5 transition-colors hover:bg-muted/50"
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

                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        type="button"
                        size="sm"
                        disabled={isBusy}
                        onClick={() => void handleDecision(item.public_id, 'accept')}
                        className="h-8 rounded-lg px-3 text-xs"
                      >
                        {isBusy ? (
                          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                        ) : (
                          <span>Chấp nhận</span>
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={isBusy}
                        onClick={() => void handleDecision(item.public_id, 'decline')}
                        className="h-8 rounded-lg px-2.5 text-xs"
                      >
                        Xóa
                      </Button>
                    </div>
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
  );
}

export function FollowRequestsModal({ open, ...rest }: FollowRequestsModalProps) {
  if (!open) {
    return null;
  }

  return <FollowRequestsDialogBody {...rest} />;
}
