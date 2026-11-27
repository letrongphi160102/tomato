'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  Ban,
  Bell,
  BellOff,
  Check,
  Copy,
  ExternalLink,
  Lock,
  Pin,
  PinOff,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';

import { UserAvatar } from '@/components/profile/user-avatar';
import { Button } from '@/components/ui/button';
import { computeConversationSafetyNumber } from '@/lib/e2ee/safety-number';
import type { ChatPeerUserDto } from '@/modules/chat';

export interface ChatInfoDrawerProps {
  readonly open: boolean;
  readonly currentUserPublicId: string;
  readonly currentUserKeyFingerprints: readonly string[];
  readonly peer: ChatPeerUserDto;
  readonly peerKeyFingerprints: readonly string[];
  readonly pinnedCount?: number;
  readonly isPinned?: boolean;
  readonly isMuted?: boolean;
  readonly canPin?: boolean;
  readonly onOpenPinnedMessages?: () => void;
  readonly onTogglePin?: () => void;
  readonly onToggleMute?: () => void;
  readonly onClose: () => void;
  readonly onRequestDeleteConversation: () => void;
  readonly onRequestBlockPeer: () => void;
}

export const ChatInfoDrawer = React.memo(function ChatInfoDrawer({
  open,
  currentUserPublicId,
  currentUserKeyFingerprints,
  peer,
  peerKeyFingerprints,
  pinnedCount = 0,
  isPinned = false,
  isMuted = false,
  canPin = false,
  onOpenPinnedMessages,
  onTogglePin,
  onToggleMute,
  onClose,
  onRequestDeleteConversation,
  onRequestBlockPeer,
}: ChatInfoDrawerProps) {
  const [safetyGroups, setSafetyGroups] = React.useState<readonly string[]>([]);
  const [safetyFormatted, setSafetyFormatted] = React.useState<string>('');
  const [copied, setCopied] = React.useState(false);

  const ownFingerprintsKey = currentUserKeyFingerprints.join('|');
  const peerFingerprintsKey = peerKeyFingerprints.join('|');

  React.useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    const ownFpList = ownFingerprintsKey ? ownFingerprintsKey.split('|') : [];
    const peerFpList = peerFingerprintsKey ? peerFingerprintsKey.split('|') : [];
    void computeConversationSafetyNumber(
      {
        userPublicId: currentUserPublicId,
        keyFingerprints: ownFpList,
      },
      {
        userPublicId: peer.public_id,
        keyFingerprints: peerFpList,
      },
    )
      .then((res) => {
        if (!cancelled) {
          setSafetyGroups(res.groups);
          setSafetyFormatted(res.formatted);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSafetyGroups([]);
          setSafetyFormatted('');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentUserPublicId, open, ownFingerprintsKey, peer.public_id, peerFingerprintsKey]);

  if (!open) {
    return null;
  }

  async function handleCopySafetyNumber() {
    if (!safetyFormatted) {
      return;
    }
    try {
      await navigator.clipboard.writeText(safetyFormatted);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Bỏ qua nếu trình duyệt không cấp quyền clipboard.
    }
  }

  return (
    <aside
      aria-label="Thông tin đoạn chat"
      className="flex h-full w-full flex-col border-l bg-background sm:w-80"
    >
      <div className="flex items-center justify-between border-b px-4 py-3.5">
        <h3 className="text-sm font-semibold text-foreground">Thông tin đoạn chat</h3>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Đóng thông tin đoạn chat"
          onClick={onClose}
          className="size-8 rounded-full"
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>

      <div className="flex-1 space-y-6 overflow-y-auto p-4">
        <div className="flex flex-col items-center text-center">
          <UserAvatar fullName={peer.fullName} avatarUrl={peer.avatarUrl} size="xl" />
          <p className="mt-3 text-base font-semibold text-foreground">{peer.fullName}</p>
          <p className="text-xs text-muted-foreground">@{peer.handle}</p>

          <Button asChild variant="outline" size="sm" className="mt-3 h-8 rounded-lg text-xs">
            <Link href={`/u/${encodeURIComponent(peer.handle)}`}>
              <span>Xem trang cá nhân</span>
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </Link>
          </Button>
        </div>

        <div className="rounded-xl border bg-muted/30 p-3.5">
          <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
            <ShieldCheck
              className="size-4 text-emerald-600 dark:text-emerald-400"
              aria-hidden="true"
            />
            <span>Mã an toàn</span>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            Bạn có thể đối chiếu dãy số dưới đây với @{peer.handle} để kiểm tra kết nối riêng tư
            giữa hai người.
          </p>

          {safetyGroups.length > 0 ? (
            <>
              <div
                aria-label="Dãy số mã an toàn"
                className="mt-3 grid grid-cols-3 gap-2 rounded-lg border bg-background p-3 text-center font-mono text-xs font-semibold tracking-wider text-foreground"
              >
                {safetyGroups.map((group, idx) => (
                  <span key={`${idx}-${group}`}>{group}</span>
                ))}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void handleCopySafetyNumber()}
                className="mt-2 h-7 w-full text-xs"
              >
                {copied ? (
                  <>
                    <Check
                      className="size-3.5 text-emerald-600 dark:text-emerald-400"
                      aria-hidden="true"
                    />
                    <span>Đã sao chép mã an toàn</span>
                  </>
                ) : (
                  <>
                    <Copy className="size-3.5" aria-hidden="true" />
                    <span>Sao chép mã an toàn</span>
                  </>
                )}
              </Button>
            </>
          ) : (
            <div className="mt-3 flex items-center gap-2 rounded-lg border bg-background p-3 text-xs text-muted-foreground">
              <Lock className="size-3.5 shrink-0" aria-hidden="true" />
              <span>Mã an toàn sẽ xuất hiện khi cả hai bên trực tuyến.</span>
            </div>
          )}
        </div>

        <div className="space-y-1 border-t pt-4">
          {onOpenPinnedMessages ? (
            <Button
              type="button"
              variant="ghost"
              onClick={onOpenPinnedMessages}
              className="w-full justify-between text-foreground"
            >
              <span className="inline-flex items-center gap-2.5">
                <Pin className="size-4 text-muted-foreground" aria-hidden="true" />
                <span>Tin nhắn đã ghim</span>
              </span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {pinnedCount}/5
              </span>
            </Button>
          ) : null}

          {canPin && onTogglePin ? (
            <Button
              type="button"
              variant="ghost"
              onClick={onTogglePin}
              className="w-full justify-start gap-2.5 text-foreground"
            >
              {isPinned ? (
                <>
                  <PinOff className="size-4 text-muted-foreground" aria-hidden="true" />
                  <span>Bỏ ghim đoạn chat</span>
                </>
              ) : (
                <>
                  <Pin className="size-4 text-muted-foreground" aria-hidden="true" />
                  <span>Ghim đoạn chat</span>
                </>
              )}
            </Button>
          ) : null}

          {onToggleMute ? (
            <Button
              type="button"
              variant="ghost"
              onClick={onToggleMute}
              className="w-full justify-start gap-2.5 text-foreground"
            >
              {isMuted ? (
                <>
                  <Bell className="size-4 text-muted-foreground" aria-hidden="true" />
                  <span>Bật thông báo</span>
                </>
              ) : (
                <>
                  <BellOff className="size-4 text-muted-foreground" aria-hidden="true" />
                  <span>Tắt thông báo</span>
                </>
              )}
            </Button>
          ) : null}

          <Button
            type="button"
            variant="ghost"
            onClick={onRequestDeleteConversation}
            className="w-full justify-start gap-2.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="size-4" aria-hidden="true" />
            <span>Xóa đoạn chat</span>
          </Button>

          <Button
            type="button"
            variant="ghost"
            onClick={onRequestBlockPeer}
            className="w-full justify-start gap-2.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <Ban className="size-4" aria-hidden="true" />
            <span>Chặn @{peer.handle}</span>
          </Button>
        </div>
      </div>
    </aside>
  );
});
