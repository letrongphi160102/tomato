'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { Loader2, MessageCircle } from 'lucide-react';

import {
  shouldRenderFloatingMessagesWidget,
  useChatUnreadCount,
} from '@/components/messages/chat-store-context';

const LazyFloatingMessagesWidget = dynamic(
  () =>
    import('@/components/messages/floating-messages-widget').then((m) => m.FloatingMessagesWidget),
  {
    ssr: false,
    loading: () => (
      <div className="fixed right-4 bottom-16 z-30 md:bottom-5">
        <div
          role="status"
          aria-label="Đang mở cửa sổ tin nhắn"
          className="flex h-[520px] max-h-[calc(100vh-5.5rem)] w-[calc(100vw-2rem)] items-center justify-center rounded-2xl border bg-background shadow-2xl sm:w-[368px]"
        >
          <Loader2 className="size-5 animate-spin text-primary" aria-hidden="true" />
        </div>
      </div>
    ),
  },
);

/**
 * Cổng khởi chạy siêu nhẹ cho `FloatingMessagesWidget`:
 * - Trả `null` tức thì trên `/messages`, `/settings/*` (0 hook nặng, 0 tải mã JS hộp thoại).
 * - Khi đang thu gọn trên `/` hoặc `/u/[handle]`, chỉ lắng nghe `useChatUnreadCount()` và chỉ nạp
 *   bundle `FloatingMessagesWidget` khi người dùng thực sự bấm mở.
 */
export function FloatingMessagesLauncher() {
  const pathname = usePathname();
  const unreadConversationsCount = useChatUnreadCount();
  const [isOpen, setIsOpen] = React.useState(false);

  if (!shouldRenderFloatingMessagesWidget(pathname)) {
    return null;
  }

  if (isOpen) {
    return <LazyFloatingMessagesWidget defaultOpen onCloseWidget={() => setIsOpen(false)} />;
  }

  const unreadMessagesCount = Math.max(0, unreadConversationsCount);
  const unreadMessagesBadgeText = unreadMessagesCount > 99 ? '99+' : String(unreadMessagesCount);

  return (
    <div className="fixed right-4 bottom-16 z-30 md:bottom-5">
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        aria-label={
          unreadMessagesCount > 0
            ? `Mở cửa sổ tin nhắn (${unreadMessagesCount} cuộc trò chuyện chưa đọc)`
            : 'Mở cửa sổ tin nhắn'
        }
        className="flex items-center gap-2.5 rounded-full border bg-background px-4 py-2.5 text-sm font-semibold text-foreground shadow-lg transition-all hover:bg-muted/60 hover:shadow-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="relative inline-flex items-center justify-center">
          <MessageCircle className="size-5 text-foreground" aria-hidden="true" />
        </span>
        <span>Tin nhắn</span>
        {unreadMessagesCount > 0 ? (
          <span
            aria-hidden="true"
            className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-[11px] font-bold leading-none text-destructive-foreground shadow-xs"
          >
            {unreadMessagesBadgeText}
          </span>
        ) : null}
      </button>
    </div>
  );
}
