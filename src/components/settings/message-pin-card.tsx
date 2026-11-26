'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';
import { CheckCircle2, KeyRound, Loader2, ShieldCheck } from 'lucide-react';

import { useChatStore } from '@/components/messages/chat-store-context';
import type {
  PinBackupModalMode,
  PinOperationCompletedPayload,
} from '@/components/messages/pin-backup-modal';

const PinBackupModal = dynamic(
  () => import('@/components/messages/pin-backup-modal').then((m) => m.PinBackupModal),
  { ssr: false },
);
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function MessagePinCard() {
  const chatStore = useChatStore();
  const [modalMode, setModalMode] = React.useState<PinBackupModalMode | null>(null);
  const [feedbackMessage, setFeedbackMessage] = React.useState<string | null>(null);

  const refreshOwnE2eeStatus = chatStore?.refreshOwnE2eeStatus;
  React.useEffect(() => {
    if (!refreshOwnE2eeStatus) {
      return;
    }
    void refreshOwnE2eeStatus();
  }, [refreshOwnE2eeStatus]);

  const pinSyncState = chatStore?.pinSyncState ?? 'loading';
  const hasKeyBackup = chatStore?.ownKeyBundle?.hasKeyBackup ?? false;
  const currentUserPublicId = chatStore?.currentUserPublicId ?? '';

  async function handlePinOperationCompleted(payload: PinOperationCompletedPayload) {
    await chatStore?.syncAfterPinOperation(payload);
    if (payload.mode === 'created') {
      setFeedbackMessage('Đã tạo mã PIN tin nhắn thành công.');
    } else if (payload.mode === 'restored') {
      setFeedbackMessage('Đã đồng bộ tin nhắn trên trình duyệt này.');
    } else if (payload.mode === 'changed') {
      setFeedbackMessage(
        'Đã đổi mã PIN tin nhắn thành công. Toàn bộ lịch sử tin nhắn vẫn được giữ nguyên.',
      );
    } else if (payload.mode === 'reset') {
      setFeedbackMessage('Đã đặt lại mã PIN tin nhắn thành công.');
    }
  }

  return (
    <>
      <Card className="shadow-sm">
        <CardHeader className="border-b pb-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <KeyRound className="size-5 text-primary" aria-hidden="true" />
              <CardTitle className="text-lg">Mã PIN tin nhắn</CardTitle>
            </div>

            {pinSyncState !== 'loading' ? (
              <span
                className={
                  hasKeyBackup
                    ? 'inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300'
                    : 'inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground'
                }
              >
                {hasKeyBackup ? (
                  <>
                    <ShieldCheck className="size-3.5" aria-hidden="true" />
                    <span>Đang bật</span>
                  </>
                ) : (
                  <span>Chưa thiết lập</span>
                )}
              </span>
            ) : null}
          </div>
          <CardDescription>
            Mã PIN 6 chữ số giúp bảo vệ và đồng bộ lịch sử tin nhắn khi bạn đăng nhập trên thiết bị
            hoặc trình duyệt mới.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4 pt-5">
          {feedbackMessage ? (
            <Alert variant="success">
              <CheckCircle2 aria-hidden="true" />
              <AlertDescription className="mt-0">{feedbackMessage}</AlertDescription>
            </Alert>
          ) : null}

          {pinSyncState === 'loading' ? (
            <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
              <span>Đang kiểm tra trạng thái mã PIN...</span>
            </div>
          ) : !hasKeyBackup ? (
            <div className="flex flex-col gap-3 rounded-xl border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-0.5 text-sm">
                <p className="font-medium text-foreground">Bạn chưa tạo mã PIN tin nhắn</p>
                <p className="text-xs text-muted-foreground">
                  Thiết lập mã PIN gồm 6 chữ số để có thể khôi phục cuộc trò chuyện trên thiết bị
                  mới bất cứ lúc nào.
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setFeedbackMessage(null);
                  setModalMode('create_mandatory');
                }}
                className="shrink-0"
              >
                <KeyRound className="size-4" aria-hidden="true" />
                <span>Tạo mã PIN</span>
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {pinSyncState === 'needs_restore' ? (
                <div className="flex flex-col gap-3 rounded-xl border border-primary/20 bg-primary/5 p-3.5 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs leading-relaxed text-foreground">
                    Trình duyệt này chưa đồng bộ các tin nhắn trước đây. Nhập mã PIN của bạn để hiển
                    thị đầy đủ lịch sử trò chuyện.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setFeedbackMessage(null);
                      setModalMode('restore');
                    }}
                    className="shrink-0"
                  >
                    Nhập mã PIN
                  </Button>
                </div>
              ) : null}

              <div className="flex flex-col gap-3 rounded-xl border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-0.5 text-sm">
                  <p className="font-medium text-foreground">Quản lý mã PIN đồng bộ</p>
                  <p className="text-xs text-muted-foreground">
                    Đổi mã PIN chỉ cần nhập đúng mã PIN hiện tại và không làm mất bất kỳ tin nhắn
                    nào.
                  </p>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setFeedbackMessage(null);
                      setModalMode('change');
                    }}
                  >
                    Đổi mã PIN
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setFeedbackMessage(null);
                      setModalMode('forgot');
                    }}
                    className="text-primary hover:text-primary"
                  >
                    Quên mã PIN?
                  </Button>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {currentUserPublicId ? (
        <PinBackupModal
          key={modalMode ?? 'settings-pin-closed'}
          open={modalMode !== null}
          initialMode={modalMode ?? 'change'}
          allowClose
          currentUserPublicId={currentUserPublicId}
          existingBackup={chatStore?.serverKeyBackup ?? null}
          onClose={() => setModalMode(null)}
          onCompleted={handlePinOperationCompleted}
        />
      ) : null}
    </>
  );
}
