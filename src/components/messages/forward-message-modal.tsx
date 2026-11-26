'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Check, Loader2, Search, Send, X } from 'lucide-react';

import type {
  DecryptedMessageViewItem,
  ForwardMessageBatchResult,
} from '@/components/messages/chat-store-context';
import { MAX_FORWARD_RECIPIENTS } from '@/components/messages/message-actions';
import { UserAvatar } from '@/components/profile/user-avatar';
import { Button } from '@/components/ui/button';
import { authFetch } from '@/lib/auth-client';
import { cn } from '@/lib/utils';
import type { ForwardTargetDto, ForwardTargetsListResult } from '@/modules/chat';

const EMPTY_SUBSCRIBE = () => () => undefined;

export interface ForwardMessageModalProps {
  readonly open: boolean;
  readonly sourceMessage: DecryptedMessageViewItem | null;
  readonly onClose: () => void;
  readonly onConfirmForward: (
    sourceMessage: DecryptedMessageViewItem,
    recipients: readonly ForwardTargetDto[],
  ) => Promise<ForwardMessageBatchResult>;
}

/**
 * Hộp thoại Chuyển tiếp tin nhắn (phong cách Instagram):
 * - Chỉ hiển thị danh sách người cùng theo dõi nhau và người đã từng trò chuyện (được lọc tại Server).
 * - Chọn tối đa 5 người nhận mỗi lượt; xử lý kết quả độc lập cho từng người nhận để 1 lỗi cục bộ
 *   không làm hỏng toàn bộ lượt chuyển tiếp.
 */
export function ForwardMessageModal({
  open,
  sourceMessage,
  onClose,
  onConfirmForward,
}: ForwardMessageModalProps) {
  const isClient = React.useSyncExternalStore(
    EMPTY_SUBSCRIBE,
    () => true,
    () => false,
  );
  const [searchQuery, setSearchQuery] = React.useState('');
  const [targets, setTargets] = React.useState<readonly ForwardTargetDto[]>([]);
  const [loadingTargets, setLoadingTargets] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [selectedMap, setSelectedMap] = React.useState<ReadonlyMap<string, ForwardTargetDto>>(
    () => new Map(),
  );
  const [limitNotice, setLimitNotice] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const [batchResult, setBatchResult] = React.useState<ForwardMessageBatchResult | null>(null);

  const searchInputId = React.useId();

  React.useEffect(() => {
    if (!open) {
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoadingTargets(true);
      setLoadError(null);
      const params = new URLSearchParams({ limit: '30' });
      const trimmed = searchQuery.trim();
      if (trimmed) {
        params.set('q', trimmed);
      }

      void authFetch(`/api/v1/conversations/forward-targets?${params.toString()}`, {
        method: 'GET',
        signal: controller.signal,
      })
        .then(async (res) => {
          if (controller.signal.aborted) {
            return;
          }
          if (!res.ok) {
            setLoadError('Không thể tải danh sách người nhận lúc này.');
            return;
          }
          const data = (await res.json()) as ForwardTargetsListResult;
          if (!controller.signal.aborted) {
            setTargets(Array.isArray(data.items) ? data.items : []);
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setLoadError('Không thể kết nối. Vui lòng thử lại.');
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setLoadingTargets(false);
          }
        });
    }, 180);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, searchQuery]);

  React.useEffect(() => {
    if (!open) {
      return;
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !sending) {
        onClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, open, sending]);

  if (!open || !sourceMessage || !isClient) {
    return null;
  }

  const selectedList = Array.from(selectedMap.values());

  function toggleTarget(target: ForwardTargetDto) {
    if (sending) {
      return;
    }
    setLimitNotice(null);
    setBatchResult(null);
    setSelectedMap((prev) => {
      const next = new Map(prev);
      if (next.has(target.public_id)) {
        next.delete(target.public_id);
        return next;
      }
      if (next.size >= MAX_FORWARD_RECIPIENTS) {
        setLimitNotice(`Bạn chỉ có thể chọn tối đa ${MAX_FORWARD_RECIPIENTS} người nhận mỗi lần.`);
        return prev;
      }
      next.set(target.public_id, target);
      return next;
    });
  }

  async function handleSendForward() {
    if (!sourceMessage || selectedList.length === 0 || sending) {
      return;
    }
    setSending(true);
    setLimitNotice(null);
    setBatchResult(null);
    try {
      const result = await onConfirmForward(sourceMessage, selectedList);
      if (result.failed.length === 0) {
        onClose();
        return;
      }
      setBatchResult(result);
      // Giữ lại các người chưa gửi được trong danh sách đã chọn nếu người dùng muốn thử lại hoặc đóng.
      const failedMap = new Map<string, ForwardTargetDto>();
      for (const f of result.failed) {
        failedMap.set(f.target.public_id, f.target);
      }
      setSelectedMap(failedMap);
    } finally {
      setSending(false);
    }
  }

  const previewSummary =
    sourceMessage.dto.messageType === 'image'
      ? 'Hình ảnh'
      : sourceMessage.dto.messageType === 'voice'
        ? 'Tin nhắn thoại'
        : sourceMessage.plaintext;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Chuyển tiếp tin nhắn"
      onClick={() => {
        if (!sending) {
          onClose();
        }
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]"
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[82vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl"
      >
        {/* Tiêu đề */}
        <header className="relative flex items-center justify-center border-b px-4 py-3.5">
          <h2 className="text-sm font-semibold text-foreground">Chuyển tiếp</h2>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={sending}
            aria-label="Đóng hộp thoại chuyển tiếp"
            onClick={onClose}
            className="absolute right-2.5 size-8 rounded-full text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </header>

        {/* Thanh tìm kiếm Tới: ... */}
        <div className="border-b px-4 py-2.5">
          <div className="flex items-center gap-2">
            <label
              htmlFor={searchInputId}
              className="shrink-0 text-xs font-semibold text-foreground"
            >
              Tới:
            </label>
            <div className="relative flex min-w-0 flex-1 items-center">
              <Search
                className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground"
                aria-hidden="true"
              />
              <input
                id={searchInputId}
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Tìm kiếm..."
                autoFocus
                className="w-full rounded-lg bg-muted/50 py-1.5 pr-3 pl-7 text-xs text-foreground placeholder:text-muted-foreground focus:bg-muted/80 focus:outline-none"
              />
            </div>
          </div>

          {selectedList.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {selectedList.map((target) => (
                <span
                  key={target.public_id}
                  className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-[11px] font-medium text-primary"
                >
                  <span className="max-w-[120px] truncate">{target.fullName}</span>
                  <button
                    type="button"
                    aria-label={`Bỏ chọn ${target.fullName}`}
                    onClick={() => toggleTarget(target)}
                    className="rounded-full p-0.5 hover:bg-primary/20"
                  >
                    <X className="size-2.5" aria-hidden="true" />
                  </button>
                </span>
              ))}
              <span className="ml-auto text-[10px] font-medium text-muted-foreground">
                {selectedList.length}/{MAX_FORWARD_RECIPIENTS}
              </span>
            </div>
          ) : null}

          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Hiển thị người cùng theo dõi nhau và người đã từng trò chuyện.
          </p>
        </div>

        {/* Xem trước nhanh nội dung sắp chuyển tiếp */}
        <div className="border-b bg-muted/25 px-4 py-2">
          <p className="truncate text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Nội dung: </span>
            {previewSummary}
          </p>
        </div>

        {/* Báo cáo chi tiết khi 1 phần người nhận chưa gửi được */}
        {batchResult ? (
          <div
            role="status"
            className="space-y-1.5 border-b bg-amber-500/10 px-4 py-2.5 text-xs text-foreground"
          >
            {batchResult.succeeded.length > 0 ? (
              <p className="flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-400">
                <Check className="size-3.5 shrink-0" aria-hidden="true" />
                <span>
                  Đã chuyển tiếp thành công tới {batchResult.succeeded.length} người nhận.
                </span>
              </p>
            ) : null}
            {batchResult.failed.map((item) => (
              <p
                key={item.target.public_id}
                className="flex items-start gap-1.5 text-[11px] text-destructive"
              >
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>
                  <span className="font-semibold">{item.target.fullName}:</span>{' '}
                  {item.errorMessage ?? 'Tạm thời chưa thể nhận tin chuyển tiếp.'}
                </span>
              </p>
            ))}
          </div>
        ) : null}

        {limitNotice ? (
          <p className="border-b bg-muted/40 px-4 py-1.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
            {limitNotice}
          </p>
        ) : null}

        {/* Danh sách người nhận đủ điều kiện */}
        <div className="min-h-[220px] flex-1 overflow-y-auto px-2 py-2">
          {loadingTargets ? (
            <div className="flex items-center justify-center gap-2 py-12 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
              <span>Đang tải danh sách...</span>
            </div>
          ) : loadError ? (
            <p className="px-4 py-10 text-center text-xs text-destructive">{loadError}</p>
          ) : targets.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-xs font-medium text-foreground">
                Không tìm thấy người nhận phù hợp
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Chỉ có thể chuyển tiếp tới người cùng theo dõi nhau hoặc người đã từng trò chuyện.
              </p>
            </div>
          ) : (
            <ul className="space-y-0.5">
              {targets.map((target) => {
                const isChecked = selectedMap.has(target.public_id);
                return (
                  <li key={target.public_id}>
                    <button
                      type="button"
                      onClick={() => toggleTarget(target)}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-muted/60',
                        isChecked ? 'bg-primary/5' : null,
                      )}
                    >
                      <UserAvatar
                        fullName={target.fullName}
                        avatarUrl={target.avatarUrl}
                        size="sm"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-semibold text-foreground">
                          {target.fullName}
                        </p>
                        <p className="truncate text-[11px] text-muted-foreground">
                          @{target.handle}
                        </p>
                      </div>
                      <span
                        aria-hidden="true"
                        className={cn(
                          'flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors',
                          isChecked
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-muted-foreground/40 bg-transparent',
                        )}
                      >
                        {isChecked ? <Check className="size-3" /> : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Nút Gửi */}
        <footer className="border-t p-3">
          <Button
            type="button"
            disabled={selectedList.length === 0 || sending}
            onClick={() => void handleSendForward()}
            className="h-9 w-full rounded-xl text-xs font-semibold"
          >
            {sending ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                <span>Đang gửi...</span>
              </>
            ) : (
              <>
                <Send className="size-3.5" aria-hidden="true" />
                <span>{selectedList.length > 1 ? `Gửi (${selectedList.length})` : 'Gửi'}</span>
              </>
            )}
          </Button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
