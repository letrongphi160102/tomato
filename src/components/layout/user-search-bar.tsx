'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2, Search, X } from 'lucide-react';

import { UserAvatar } from '@/components/profile/user-avatar';
import { authFetch } from '@/lib/auth-client';
import { cn } from '@/lib/utils';
import { SEARCH_QUERY_MIN_LENGTH, normalizeSearchQuery } from '@/modules/profile/handle';
import type { UserSearchItemDto } from '@/modules/profile/profile.service';

export interface UserSearchBarProps {
  readonly className?: string;
}

const SEARCH_DEBOUNCE_MS = 280;

export function UserSearchBar({ className }: UserSearchBarProps) {
  const router = useRouter();
  const searchInputId = React.useId();
  const resultsListId = `${searchInputId}-results`;
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  const [query, setQuery] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [items, setItems] = React.useState<readonly UserSearchItemDto[]>([]);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [highlightedIndex, setHighlightedIndex] = React.useState(-1);

  const normalizedQuery = normalizeSearchQuery(query);
  const hasMinChars = normalizedQuery.length >= SEARCH_QUERY_MIN_LENGTH;

  React.useEffect(() => {
    if (!open) {
      return;
    }
    function handlePointerDown(event: MouseEvent) {
      if (
        containerRef.current &&
        event.target instanceof Node &&
        !containerRef.current.contains(event.target)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  React.useEffect(() => {
    if (!hasMinChars) {
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setErrorMessage(null);

      try {
        const params = new URLSearchParams({ q: normalizedQuery });
        const response = await authFetch(`/api/v1/users/search?${params.toString()}`, {
          method: 'GET',
          signal: controller.signal,
        });

        if (controller.signal.aborted) {
          return;
        }

        if (!response.ok) {
          const errorBody = (await response.json().catch(() => null)) as {
            readonly error?: { readonly message?: string };
          } | null;
          setItems([]);
          setErrorMessage(
            errorBody?.error?.message ?? 'Không thể tìm kiếm lúc này. Vui lòng thử lại.',
          );
          return;
        }

        const data = (await response.json()) as { readonly items?: UserSearchItemDto[] };
        setItems(Array.isArray(data.items) ? data.items : []);
        setHighlightedIndex(-1);
      } catch {
        if (!controller.signal.aborted) {
          setItems([]);
          setErrorMessage('Không thể kết nối. Vui lòng thử lại.');
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [hasMinChars, normalizedQuery]);

  const displayedItems = hasMinChars ? items : [];
  const displayedLoading = hasMinChars && loading;
  const displayedError = hasMinChars ? errorMessage : null;

  function handleQueryChange(nextValue: string) {
    setQuery(nextValue);
    setOpen(true);
    if (normalizeSearchQuery(nextValue).length < SEARCH_QUERY_MIN_LENGTH) {
      setItems([]);
      setLoading(false);
      setErrorMessage(null);
      setHighlightedIndex(-1);
    }
  }

  function handleSelectUser(handle: string) {
    setOpen(false);
    setQuery('');
    setItems([]);
    setHighlightedIndex(-1);
    router.push(`/u/${encodeURIComponent(handle)}`);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }

    if (!open || displayedItems.length === 0) {
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlightedIndex((prev) => (prev + 1) % displayedItems.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightedIndex((prev) => (prev <= 0 ? displayedItems.length - 1 : prev - 1));
    } else if (event.key === 'Enter' && highlightedIndex >= 0) {
      event.preventDefault();
      const chosen = displayedItems[highlightedIndex];
      if (chosen) {
        handleSelectUser(chosen.handle);
      }
    }
  }

  return (
    <div ref={containerRef} className={cn('relative w-full max-w-xs sm:max-w-sm', className)}>
      <div className="relative flex items-center">
        <Search
          className="pointer-events-none absolute left-3 size-4 text-muted-foreground"
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          id={searchInputId}
          name="userSearch"
          type="search"
          autoComplete="off"
          role="combobox"
          aria-label="Tìm kiếm người dùng theo tên hoặc ID tài khoản"
          aria-expanded={open}
          aria-controls={resultsListId}
          aria-autocomplete="list"
          value={query}
          placeholder="Tìm kiếm người dùng..."
          onFocus={() => setOpen(true)}
          onChange={(event) => handleQueryChange(event.target.value)}
          onKeyDown={handleKeyDown}
          className="h-9 w-full rounded-full border border-border/80 bg-muted/50 pl-9 pr-8 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:border-primary/40 focus:bg-background focus:outline-none focus:ring-2 focus:ring-primary/15 [&::-webkit-search-cancel-button]:hidden"
        />
        {query.length > 0 ? (
          <button
            type="button"
            aria-label="Xóa từ khóa tìm kiếm"
            onClick={() => {
              handleQueryChange('');
              inputRef.current?.focus();
            }}
            className="absolute right-2.5 flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {open && query.trim().length > 0 ? (
        <div
          id={resultsListId}
          role="listbox"
          aria-label="Kết quả tìm kiếm người dùng"
          className="absolute left-0 right-0 z-40 mt-2 max-h-96 overflow-y-auto rounded-2xl border bg-background p-1.5 shadow-xl"
        >
          {!hasMinChars ? (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              Nhập ít nhất 2 ký tự để tìm kiếm người dùng.
            </p>
          ) : displayedLoading ? (
            <div className="flex items-center justify-center gap-2 px-3 py-5 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
              <span>Đang tìm kiếm...</span>
            </div>
          ) : displayedError ? (
            <p className="px-3 py-4 text-center text-xs text-destructive">{displayedError}</p>
          ) : displayedItems.length === 0 ? (
            <p className="px-3 py-5 text-center text-sm text-muted-foreground">
              Không tìm thấy người dùng phù hợp.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {displayedItems.map((item, index) => {
                const isActive = index === highlightedIndex;
                return (
                  <li key={item.public_id} role="option" aria-selected={isActive}>
                    <Link
                      href={`/u/${encodeURIComponent(item.handle)}`}
                      onClick={() => {
                        setOpen(false);
                        setQuery('');
                        setItems([]);
                        setHighlightedIndex(-1);
                      }}
                      className={cn(
                        'flex items-center gap-3 rounded-xl px-3 py-2 transition-colors',
                        isActive ? 'bg-muted' : 'hover:bg-muted/70',
                      )}
                    >
                      <UserAvatar fullName={item.fullName} avatarUrl={item.avatarUrl} size="sm" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <p className="truncate text-sm font-semibold text-foreground">
                            @{item.handle}
                          </p>
                          {item.followStatus === 'following' ? (
                            <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
                              · Đang theo dõi
                            </span>
                          ) : item.followStatus === 'requested' ? (
                            <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
                              · Đã gửi yêu cầu
                            </span>
                          ) : null}
                        </div>
                        <p className="truncate text-xs text-muted-foreground">{item.fullName}</p>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
