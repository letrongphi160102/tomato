'use client';

import * as React from 'react';
import { Ban, CheckCircle2, Loader2, Lock, UserPlus } from 'lucide-react';

import { UserAvatar } from '@/components/profile/user-avatar';
import { ConfirmDialog } from '@/components/social/confirm-dialog';
import { FollowRequestsModal } from '@/components/social/follow-requests-modal';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { authFetch } from '@/lib/auth-client';
import { cn } from '@/lib/utils';
import type { PrivacySettingsDto, SocialBlockedUserItemDto } from '@/modules/social/social.service';

export interface PrivacySettingsPanelProps {
  readonly initialPrivacy: PrivacySettingsDto;
  readonly initialBlockedItems: readonly SocialBlockedUserItemDto[];
  readonly initialBlockedNextCursor: string | null;
}

export function PrivacySettingsPanel({
  initialPrivacy,
  initialBlockedItems,
  initialBlockedNextCursor,
}: PrivacySettingsPanelProps) {
  const [isPrivate, setIsPrivate] = React.useState(initialPrivacy.isPrivate);
  const [pendingRequestsCount, setPendingRequestsCount] = React.useState(
    initialPrivacy.pendingFollowRequestsCount,
  );
  const [savingPrivacy, setSavingPrivacy] = React.useState(false);
  const [privacyMessage, setPrivacyMessage] = React.useState<string | null>(null);
  const [privacyError, setPrivacyError] = React.useState<string | null>(null);

  const [confirmPublicOpen, setConfirmPublicOpen] = React.useState(false);
  const [acceptPendingOnPublic, setAcceptPendingOnPublic] = React.useState(true);
  const [requestsModalOpen, setRequestsModalOpen] = React.useState(false);

  const [blockedItems, setBlockedItems] =
    React.useState<readonly SocialBlockedUserItemDto[]>(initialBlockedItems);
  const [blockedNextCursor, setBlockedNextCursor] = React.useState<string | null>(
    initialBlockedNextCursor,
  );
  const [loadingMoreBlocks, setLoadingMoreBlocks] = React.useState(false);
  const [blocksError, setBlocksError] = React.useState<string | null>(null);
  const [blocksMessage, setBlocksMessage] = React.useState<string | null>(null);

  const [confirmUnblockTarget, setConfirmUnblockTarget] =
    React.useState<SocialBlockedUserItemDto | null>(null);
  const [unblocking, setUnblocking] = React.useState(false);
  const [unblockError, setUnblockError] = React.useState<string | null>(null);

  async function submitPrivacyChange(nextIsPrivate: boolean, acceptPendingRequests = true) {
    if (savingPrivacy) {
      return;
    }
    setSavingPrivacy(true);
    setPrivacyError(null);
    setPrivacyMessage(null);

    try {
      const payload = nextIsPrivate
        ? { isPrivate: true }
        : { isPrivate: false, acceptPendingRequests };

      const response = await authFetch('/api/v1/users/me/privacy', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          readonly error?: { readonly message?: string };
        } | null;
        setPrivacyError(body?.error?.message ?? 'Không thể cập nhật cài đặt quyền riêng tư.');
        return;
      }

      const data = (await response.json()) as {
        readonly privacy: PrivacySettingsDto;
        readonly acceptedRequestsCount: number;
        readonly message: string;
      };

      setIsPrivate(data.privacy.isPrivate);
      setPendingRequestsCount(data.privacy.pendingFollowRequestsCount);
      setConfirmPublicOpen(false);
      if (!data.privacy.isPrivate && data.acceptedRequestsCount > 0) {
        setPrivacyMessage(
          `Đã chuyển sang tài khoản công khai và chấp nhận ${data.acceptedRequestsCount} yêu cầu theo dõi.`,
        );
      } else {
        setPrivacyMessage(data.message);
      }
    } catch {
      setPrivacyError('Không thể kết nối. Vui lòng thử lại.');
    } finally {
      setSavingPrivacy(false);
    }
  }

  function handleTogglePrivateClick() {
    if (savingPrivacy) {
      return;
    }
    if (isPrivate) {
      setAcceptPendingOnPublic(true);
      setPrivacyError(null);
      setConfirmPublicOpen(true);
      return;
    }
    void submitPrivacyChange(true);
  }

  async function handleLoadMoreBlocks() {
    if (!blockedNextCursor || loadingMoreBlocks) {
      return;
    }
    setLoadingMoreBlocks(true);
    setBlocksError(null);
    try {
      const params = new URLSearchParams({ limit: '20', cursor: blockedNextCursor });
      const response = await authFetch(`/api/v1/social/blocks?${params.toString()}`, {
        method: 'GET',
      });
      if (!response.ok) {
        setBlocksError('Không thể tải thêm danh sách đã chặn.');
        return;
      }
      const data = (await response.json()) as {
        readonly items?: SocialBlockedUserItemDto[];
        readonly nextCursor?: string | null;
      };
      const incoming = Array.isArray(data.items) ? data.items : [];
      setBlockedItems((prev) => {
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
      setBlockedNextCursor(typeof data.nextCursor === 'string' ? data.nextCursor : null);
    } catch {
      setBlocksError('Không thể kết nối. Vui lòng thử lại.');
    } finally {
      setLoadingMoreBlocks(false);
    }
  }

  async function handleConfirmUnblock() {
    if (!confirmUnblockTarget || unblocking) {
      return;
    }
    setUnblocking(true);
    setUnblockError(null);
    setBlocksMessage(null);

    try {
      const response = await authFetch(
        `/api/v1/social/blocks/${encodeURIComponent(confirmUnblockTarget.public_id)}`,
        { method: 'DELETE' },
      );

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          readonly error?: { readonly message?: string };
        } | null;
        setUnblockError(body?.error?.message ?? 'Không thể bỏ chặn tài khoản này.');
        return;
      }

      const unblockedHandle = confirmUnblockTarget.handle;
      setBlockedItems((prev) =>
        prev.filter((item) => item.public_id !== confirmUnblockTarget.public_id),
      );
      setConfirmUnblockTarget(null);
      setBlocksMessage(`Đã bỏ chặn @${unblockedHandle}.`);
    } catch {
      setUnblockError('Không thể kết nối. Vui lòng thử lại.');
    } finally {
      setUnblocking(false);
    }
  }

  return (
    <>
      <div className="space-y-6">
        <Card className="shadow-sm">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Lock className="size-5 text-primary" aria-hidden="true" />
              <CardTitle className="text-lg">Quyền riêng tư tài khoản</CardTitle>
            </div>
            <CardDescription>
              Kiểm soát những ai có thể theo dõi và xem danh sách kết nối trên trang cá nhân của
              bạn.
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            <div className="flex items-start justify-between gap-4 rounded-xl border bg-muted/20 p-4">
              <div className="space-y-1">
                <p id="private-account-label" className="text-sm font-semibold text-foreground">
                  Tài khoản riêng tư
                </p>
                <p
                  id="private-account-description"
                  className="text-xs leading-relaxed text-muted-foreground"
                >
                  Khi bật chế độ này, những người muốn theo dõi bạn sẽ cần gửi yêu cầu để bạn phê
                  duyệt. Chỉ những người theo dõi được chấp nhận mới có thể xem danh sách theo dõi
                  và kết nối đầy đủ với bạn.
                </p>
              </div>

              <button
                type="button"
                role="switch"
                aria-checked={isPrivate}
                aria-labelledby="private-account-label"
                aria-describedby="private-account-description"
                disabled={savingPrivacy}
                onClick={handleTogglePrivateClick}
                className={cn(
                  'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60',
                  isPrivate ? 'bg-primary' : 'bg-input',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'pointer-events-none inline-block size-5 rounded-full bg-background shadow-sm transition-transform',
                    isPrivate ? 'translate-x-5' : 'translate-x-0',
                  )}
                />
              </button>
            </div>

            {pendingRequestsCount > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-background px-4 py-3">
                <div className="flex items-center gap-2.5 text-sm">
                  <div className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <UserPlus className="size-4" aria-hidden="true" />
                  </div>
                  <div>
                    <p className="font-medium text-foreground">
                      Bạn có {pendingRequestsCount} yêu cầu theo dõi đang chờ
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Xem và phê duyệt những người muốn theo dõi tài khoản của bạn.
                    </p>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setRequestsModalOpen(true)}
                >
                  Xem yêu cầu
                </Button>
              </div>
            ) : null}

            {privacyMessage ? (
              <Alert>
                <CheckCircle2 className="size-4 text-primary" aria-hidden="true" />
                <AlertDescription>{privacyMessage}</AlertDescription>
              </Alert>
            ) : null}

            {privacyError ? (
              <Alert variant="destructive">
                <AlertDescription>{privacyError}</AlertDescription>
              </Alert>
            ) : null}
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Ban className="size-5 text-primary" aria-hidden="true" />
              <CardTitle className="text-lg">Tài khoản đã chặn</CardTitle>
            </div>
            <CardDescription>
              Những tài khoản bạn đã chặn sẽ không thể tìm thấy trang cá nhân hay tương tác với bạn
              trên Tomato.
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            {blocksMessage ? (
              <Alert>
                <CheckCircle2 className="size-4 text-primary" aria-hidden="true" />
                <AlertDescription>{blocksMessage}</AlertDescription>
              </Alert>
            ) : null}

            {blocksError ? (
              <Alert variant="destructive">
                <AlertDescription>{blocksError}</AlertDescription>
              </Alert>
            ) : null}

            {blockedItems.length === 0 ? (
              <div className="rounded-xl border border-dashed bg-muted/20 px-5 py-10 text-center">
                <p className="text-sm font-medium text-foreground">Bạn chưa chặn tài khoản nào.</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Khi bạn chặn ai đó từ trang cá nhân của họ, tài khoản đó sẽ xuất hiện tại đây.
                </p>
              </div>
            ) : (
              <ul className="divide-y rounded-xl border">
                {blockedItems.map((item) => (
                  <li
                    key={item.public_id}
                    className="flex items-center justify-between gap-3 px-4 py-3"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <UserAvatar fullName={item.fullName} avatarUrl={item.avatarUrl} size="sm" />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-foreground">
                          @{item.handle}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">{item.fullName}</p>
                      </div>
                    </div>

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setUnblockError(null);
                        setConfirmUnblockTarget(item);
                      }}
                      className="h-8 shrink-0 rounded-lg text-xs"
                    >
                      Bỏ chặn
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            {blockedNextCursor ? (
              <div className="text-center">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={loadingMoreBlocks}
                  onClick={() => void handleLoadMoreBlocks()}
                >
                  {loadingMoreBlocks ? (
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
          </CardContent>
        </Card>
      </div>

      <ConfirmDialog
        open={confirmPublicOpen}
        title="Chuyển sang tài khoản công khai?"
        description="Mọi người trên Tomato sẽ có thể theo dõi bạn ngay lập tức và xem danh sách người theo dõi của bạn."
        confirmLabel="Chuyển sang công khai"
        loading={savingPrivacy}
        errorMessage={privacyError}
        onClose={() => {
          if (!savingPrivacy) {
            setConfirmPublicOpen(false);
          }
        }}
        onConfirm={() => submitPrivacyChange(false, acceptPendingOnPublic)}
      >
        {pendingRequestsCount > 0 ? (
          <div className="flex items-start gap-2.5 rounded-xl border bg-muted/30 p-3">
            <Checkbox
              id="accept-pending-requests-checkbox"
              checked={acceptPendingOnPublic}
              disabled={savingPrivacy}
              onCheckedChange={(checked) => setAcceptPendingOnPublic(checked === true)}
              className="mt-0.5"
            />
            <Label
              htmlFor="accept-pending-requests-checkbox"
              className="cursor-pointer text-xs font-normal leading-relaxed text-foreground"
            >
              Tự động chấp nhận <strong>{pendingRequestsCount}</strong> yêu cầu theo dõi đang chờ
              (nếu bỏ chọn, các yêu cầu đang chờ sẽ bị xóa).
            </Label>
          </div>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmUnblockTarget !== null}
        title={confirmUnblockTarget ? `Bỏ chặn @${confirmUnblockTarget.handle}?` : 'Bỏ chặn?'}
        description="Hai bạn sẽ có thể tìm thấy nhau trở lại trên Tomato. Việc bỏ chặn sẽ không tự động khôi phục trạng thái theo dõi trước đó."
        confirmLabel="Bỏ chặn"
        loading={unblocking}
        errorMessage={unblockError}
        onClose={() => {
          if (!unblocking) {
            setConfirmUnblockTarget(null);
            setUnblockError(null);
          }
        }}
        onConfirm={handleConfirmUnblock}
      />

      <FollowRequestsModal
        open={requestsModalOpen}
        onClose={() => setRequestsModalOpen(false)}
        onAccepted={() => {
          setPendingRequestsCount((prev) => Math.max(0, prev - 1));
        }}
        onDeclined={() => {
          setPendingRequestsCount((prev) => Math.max(0, prev - 1));
        }}
      />
    </>
  );
}
