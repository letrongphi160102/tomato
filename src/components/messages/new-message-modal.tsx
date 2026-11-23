'use client';

import * as React from 'react';
import { Loader2, Search, X } from 'lucide-react';

import { UserAvatar } from '@/components/profile/user-avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authFetch } from '@/lib/auth-client';
import type { UserSearchItemDto } from '@/modules/profile';

export interface NewMessageModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSelectRecipient: (userPublicId: string) => Promise<void>;
}

export function NewMessageModal({ open, onClose, onSelectRecipient }: NewMessageModalProps) {
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<readonly UserSearchItemDto[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [startingId, setStartingId] = React.useState<string | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  const cleanQuery = query.trim().replace(/^@+/, '');

  React.useEffect(() => {
    if (!open || cleanQuery.length < 2) {
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearching(true);
      void authFetch(`/api/v1/users/search?q=${encodeURIComponent(cleanQuery)}`, {
        method: 'GET',
        signal: controller.signal,
      })
        .then(async (res) => {
          if (controller.signal.aborted || !res.ok) {
            return;
          }
          const data = (await res.json()) as { readonly items?: UserSearchItemDto[] };
          setResults(Array.isArray(data.items) ? data.items : []);
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setResults([]);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setSearching(false);
          }
        });
    }, 260);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [cleanQuery, open]);

  if (!open) {
    return null;
  }

  const displayedResults = cleanQuery.length < 2 ? [] : results;

  async function handleChooseUser(userPublicId: string) {
    if (startingId) {
      return;
    }
    setStartingId(userPublicId);
    setErrorMessage(null);
    try {
      await onSelectRecipient(userPublicId);
      onClose();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Không thể mở cuộc trò chuyện lúc này.',
      );
    } finally {
      setStartingId(null);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-message-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs"
    >
      <div className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-4 py-3.5">
          <h2 id="new-message-modal-title" className="text-sm font-semibold text-foreground">
            Tin nhắn mới
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

        <div className="border-b px-4 py-2.5">
          <div className="relative flex items-center">
            <Search
              className="pointer-events-none absolute left-3 size-4 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              placeholder="Tìm theo @tên_người_dùng hoặc tên hiển thị..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9"
              autoFocus
            />
          </div>
        </div>

        {errorMessage ? (
          <p
            role="alert"
            className="border-b bg-destructive/5 px-4 py-2 text-xs font-medium text-destructive"
          >
            {errorMessage}
          </p>
        ) : null}

        <div className="flex-1 overflow-y-auto p-2">
          {searching ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
              <span>Đang tìm kiếm...</span>
            </div>
          ) : displayedResults.length === 0 ? (
            <div className="py-10 text-center text-xs text-muted-foreground">
              {cleanQuery.length < 2
                ? 'Nhập ít nhất 2 ký tự để tìm người nhận.'
                : 'Không tìm thấy tài khoản phù hợp.'}
            </div>
          ) : (
            <ul className="space-y-1">
              {displayedResults.map((item) => {
                const isBusy = startingId === item.public_id;
                return (
                  <li key={item.public_id}>
                    <button
                      type="button"
                      disabled={startingId !== null}
                      onClick={() => void handleChooseUser(item.public_id)}
                      className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-muted disabled:opacity-60"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <UserAvatar fullName={item.fullName} avatarUrl={item.avatarUrl} size="sm" />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-foreground">
                            {item.fullName}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">@{item.handle}</p>
                        </div>
                      </div>
                      {isBusy ? (
                        <Loader2
                          className="size-4 shrink-0 animate-spin text-primary"
                          aria-hidden="true"
                        />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
