'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  KeyRound,
  Loader2,
  Lock,
  Mail,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authFetch } from '@/lib/auth-client';
import { saveDeviceKeyMaterial } from '@/lib/e2ee/keystore';
import {
  createPinProtectedKeyBackup,
  reEncryptPinProtectedKeyBackup,
  restorePinProtectedKeyBackup,
  type EncryptedKeyBackupBundleDto,
} from '@/lib/e2ee/pin-backup';
import type { E2eeKeyBackupDto } from '@/modules/chat';

export type PinBackupModalMode = 'create_mandatory' | 'restore' | 'change' | 'forgot';

export interface PinOperationCompletedPayload {
  readonly mode: 'created' | 'restored' | 'changed' | 'reset';
  readonly updatedBackup?: E2eeKeyBackupDto | null;
}

export interface PinBackupModalProps {
  readonly open: boolean;
  readonly initialMode: PinBackupModalMode;
  readonly allowClose?: boolean;
  readonly currentUserPublicId: string;
  readonly existingBackup: E2eeKeyBackupDto | null;
  readonly onClose: () => void;
  readonly onCompleted: (payload: PinOperationCompletedPayload) => Promise<void> | void;
}

interface ApiErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
  };
}

function sanitizePinInput(value: string): string {
  return value.replace(/\D/g, '').slice(0, 6);
}

function toBundleDto(backup: E2eeKeyBackupDto): EncryptedKeyBackupBundleDto {
  return {
    encryptedKeyBlob: backup.encryptedKeyBlob,
    kdfSalt: backup.kdfSalt,
    kdfParams: backup.kdfParams,
    iv: backup.iv,
    keyFingerprint: backup.keyFingerprint,
    version: backup.version,
  };
}

async function fetchLatestBackupFromServer(): Promise<E2eeKeyBackupDto | null> {
  const response = await authFetch('/api/v1/e2ee/backup', { method: 'GET' });
  if (!response.ok) {
    const errBody = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new Error(errBody?.error?.message ?? 'Không thể tải thông tin mã PIN lúc này.');
  }
  const data = (await response.json()) as { readonly backup?: E2eeKeyBackupDto | null };
  return data.backup ?? null;
}

export interface MandatoryPinSetupPanelProps {
  readonly currentUserPublicId: string;
  readonly compact?: boolean;
  readonly onCompleted: (payload: PinOperationCompletedPayload) => Promise<void> | void;
}

/**
 * Biểu mẫu tạo Mã PIN 6 số bắt buộc lần đầu (dùng trực tiếp bên trong `FloatingMessagesWidget`
 * khi tài khoản chưa từng tạo mã PIN — không có nút bỏ qua để vào nhắn tin).
 */
export function MandatoryPinSetupPanel({
  currentUserPublicId,
  compact = false,
  onCompleted,
}: MandatoryPinSetupPanelProps) {
  const [pin, setPin] = React.useState('');
  const [confirmPin, setConfirmPin] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) {
      return;
    }

    if (!/^\d{6}$/.test(pin)) {
      setErrorMessage('Vui lòng nhập mã PIN gồm đúng 6 chữ số.');
      return;
    }
    if (pin !== confirmPin) {
      setErrorMessage('Mã PIN xác nhận chưa trùng khớp.');
      return;
    }

    setSubmitting(true);
    setErrorMessage(null);

    try {
      const created = await createPinProtectedKeyBackup({
        userPublicId: currentUserPublicId,
        pin,
        persistLocally: false,
      });

      const response = await authFetch('/api/v1/e2ee/backup', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          encryptedKeyBlob: created.backup.encryptedKeyBlob,
          kdfSalt: created.backup.kdfSalt,
          kdfParams: created.backup.kdfParams,
          iv: created.backup.iv,
          keyFingerprint: created.backup.keyFingerprint,
          identityPublicKeyJwk: created.publicRegistration.identityPublicKeyJwk,
          signingPublicKeyJwk: created.publicRegistration.signingPublicKeyJwk,
          deviceLabel: created.publicRegistration.deviceLabel,
        }),
      });

      if (!response.ok) {
        const errBody = (await response.json().catch(() => null)) as ApiErrorBody | null;
        throw new Error(errBody?.error?.message ?? 'Không thể lưu mã PIN lúc này.');
      }

      const data = (await response.json().catch(() => null)) as {
        readonly backup?: E2eeKeyBackupDto;
      } | null;

      await saveDeviceKeyMaterial(created.localMaterial, 'backup');
      await onCompleted({ mode: 'created', updatedBackup: data?.backup ?? null });
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Không thể tạo mã PIN. Vui lòng thử lại.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={compact ? 'flex flex-1 flex-col justify-center p-4' : 'p-6'}>
      <div className="mx-auto flex size-11 items-center justify-center rounded-full bg-primary/10 text-primary">
        <KeyRound className="size-5" aria-hidden="true" />
      </div>
      <h3 className="mt-3 text-center text-sm font-semibold text-foreground">
        Tạo mã PIN tin nhắn
      </h3>
      <p className="mt-1 text-center text-xs leading-relaxed text-muted-foreground">
        Tạo mã PIN gồm 6 chữ số để bảo vệ và đồng bộ lịch sử trò chuyện khi bạn đăng nhập trên thiết
        bị mới.
      </p>

      <form onSubmit={(e) => void handleSubmit(e)} className="mt-4 space-y-3">
        <div className="space-y-1">
          <Label htmlFor="mandatory-pin-input" className="text-xs">
            Mã PIN (6 chữ số)
          </Label>
          <Input
            id="mandatory-pin-input"
            name="mandatoryPin"
            type="password"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            autoComplete="off"
            placeholder="••••••"
            value={pin}
            onChange={(e) => {
              setPin(sanitizePinInput(e.target.value));
              setErrorMessage(null);
            }}
            disabled={submitting}
            className="text-center font-mono text-base tracking-[0.35em]"
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="mandatory-pin-confirm" className="text-xs">
            Nhập lại mã PIN
          </Label>
          <Input
            id="mandatory-pin-confirm"
            name="mandatoryPinConfirm"
            type="password"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            autoComplete="off"
            placeholder="••••••"
            value={confirmPin}
            onChange={(e) => {
              setConfirmPin(sanitizePinInput(e.target.value));
              setErrorMessage(null);
            }}
            disabled={submitting}
            className="text-center font-mono text-base tracking-[0.35em]"
          />
        </div>

        {errorMessage ? (
          <p role="alert" className="text-xs font-medium text-destructive">
            {errorMessage}
          </p>
        ) : null}

        <Button
          type="submit"
          size="sm"
          disabled={submitting || pin.length !== 6 || confirmPin.length !== 6}
          className="w-full rounded-xl"
        >
          {submitting ? (
            <>
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              <span>Đang thiết lập...</span>
            </>
          ) : (
            <span>Tạo mã PIN</span>
          )}
        </Button>
      </form>
    </div>
  );
}

export function PinBackupModal({
  open,
  initialMode,
  allowClose = true,
  currentUserPublicId,
  existingBackup,
  onClose,
  onCompleted,
}: PinBackupModalProps) {
  const titleId = React.useId();
  const [mode, setMode] = React.useState<PinBackupModalMode>(initialMode);
  const [previousModeBeforeForgot, setPreviousModeBeforeForgot] = React.useState<
    'restore' | 'change'
  >(initialMode === 'change' ? 'change' : 'restore');

  // Trạng thái dùng cho Tạo mới / Nhập PIN / Đổi PIN
  const [currentPin, setCurrentPin] = React.useState('');
  const [pin, setPin] = React.useState('');
  const [confirmPin, setConfirmPin] = React.useState('');

  // Trạng thái dùng cho Quên mã PIN (2 bước xác thực Email)
  const [forgotStep, setForgotStep] = React.useState<'warning' | 'confirm'>('warning');
  const [maskedEmail, setMaskedEmail] = React.useState<string | null>(null);
  const [otpCode, setOtpCode] = React.useState('');
  const [resendCooldownSeconds, setResendCooldownSeconds] = React.useState(0);
  const [requestingOtp, setRequestingOtp] = React.useState(false);

  const [submitting, setSubmitting] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [successMessage, setSuccessMessage] = React.useState<string | null>(null);

  const canCloseNow = allowClose && !submitting && !requestingOtp;

  React.useEffect(() => {
    if (resendCooldownSeconds <= 0) {
      return;
    }
    const timer = window.setInterval(() => {
      setResendCooldownSeconds((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendCooldownSeconds]);

  React.useEffect(() => {
    if (!open || !canCloseNow) {
      return;
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, canCloseNow, onClose]);

  if (!open || typeof document === 'undefined') {
    return null;
  }

  function switchToForgotMode() {
    if (mode === 'restore' || mode === 'change') {
      setPreviousModeBeforeForgot(mode);
    }
    setMode('forgot');
    setForgotStep('warning');
    setOtpCode('');
    setPin('');
    setConfirmPin('');
    setErrorMessage(null);
    setSuccessMessage(null);
  }

  function switchBackFromForgot() {
    setMode(previousModeBeforeForgot);
    setErrorMessage(null);
    setSuccessMessage(null);
  }

  async function handleRequestResetOtp() {
    if (requestingOtp || resendCooldownSeconds > 0 || submitting) {
      return;
    }

    setRequestingOtp(true);
    setErrorMessage(null);

    try {
      const response = await authFetch('/api/v1/e2ee/backup/reset/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      if (!response.ok) {
        const errBody = (await response.json().catch(() => null)) as ApiErrorBody | null;
        if (response.status === 429) {
          const retryHeader = Number(response.headers.get('Retry-After') ?? '60');
          if (Number.isFinite(retryHeader) && retryHeader > 0) {
            setResendCooldownSeconds(Math.ceil(retryHeader));
          }
        }
        throw new Error(
          errBody?.error?.message ?? 'Không thể gửi mã xác nhận lúc này. Vui lòng thử lại.',
        );
      }

      const data = (await response.json()) as {
        readonly maskedEmail: string;
        readonly resendAfterSeconds: number;
      };
      setMaskedEmail(data.maskedEmail);
      setResendCooldownSeconds(data.resendAfterSeconds || 60);
      setForgotStep('confirm');
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Không thể gửi mã xác nhận qua email.',
      );
    } finally {
      setRequestingOtp(false);
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting || requestingOtp) {
      return;
    }

    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      if (mode === 'create_mandatory') {
        if (!/^\d{6}$/.test(pin)) {
          setErrorMessage('Vui lòng nhập mã PIN gồm đúng 6 chữ số.');
          return;
        }
        if (pin !== confirmPin) {
          setErrorMessage('Mã PIN xác nhận không trùng khớp.');
          return;
        }

        setSubmitting(true);
        const created = await createPinProtectedKeyBackup({
          userPublicId: currentUserPublicId,
          pin,
          persistLocally: false,
        });

        const response = await authFetch('/api/v1/e2ee/backup', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            encryptedKeyBlob: created.backup.encryptedKeyBlob,
            kdfSalt: created.backup.kdfSalt,
            kdfParams: created.backup.kdfParams,
            iv: created.backup.iv,
            keyFingerprint: created.backup.keyFingerprint,
            identityPublicKeyJwk: created.publicRegistration.identityPublicKeyJwk,
            signingPublicKeyJwk: created.publicRegistration.signingPublicKeyJwk,
            deviceLabel: created.publicRegistration.deviceLabel,
          }),
        });

        if (!response.ok) {
          const errBody = (await response.json().catch(() => null)) as ApiErrorBody | null;
          throw new Error(errBody?.error?.message ?? 'Không thể lưu mã PIN lúc này.');
        }

        const data = (await response.json().catch(() => null)) as {
          readonly backup?: E2eeKeyBackupDto;
        } | null;

        await saveDeviceKeyMaterial(created.localMaterial, 'backup');
        setSuccessMessage('Đã tạo mã PIN tin nhắn thành công.');
        onClose();
        void Promise.resolve(onCompleted({ mode: 'created', updatedBackup: data?.backup ?? null }));
        return;
      }

      if (mode === 'restore') {
        if (!/^\d{6}$/.test(pin)) {
          setErrorMessage('Vui lòng nhập mã PIN gồm đúng 6 chữ số.');
          return;
        }

        setSubmitting(true);
        const targetBackup = existingBackup ?? (await fetchLatestBackupFromServer());
        if (!targetBackup) {
          throw new Error('Không tìm thấy dữ liệu đồng bộ mã PIN cho tài khoản này.');
        }

        await restorePinProtectedKeyBackup({
          userPublicId: currentUserPublicId,
          pin,
          backup: toBundleDto(targetBackup),
        });

        setSuccessMessage('Đã đồng bộ tin nhắn thành công.');
        onClose();
        void Promise.resolve(onCompleted({ mode: 'restored', updatedBackup: targetBackup }));
        return;
      }

      if (mode === 'change') {
        if (!/^\d{6}$/.test(currentPin)) {
          setErrorMessage('Vui lòng nhập mã PIN hiện tại gồm đúng 6 chữ số.');
          return;
        }
        if (!/^\d{6}$/.test(pin)) {
          setErrorMessage('Vui lòng nhập mã PIN mới gồm đúng 6 chữ số.');
          return;
        }
        if (pin === currentPin) {
          setErrorMessage('Mã PIN mới phải khác mã PIN hiện tại.');
          return;
        }
        if (pin !== confirmPin) {
          setErrorMessage('Mã PIN xác nhận không trùng khớp.');
          return;
        }

        setSubmitting(true);
        const latestBackup = await fetchLatestBackupFromServer();
        if (!latestBackup) {
          throw new Error('Tài khoản chưa thiết lập mã PIN tin nhắn.');
        }

        const reEncrypted = await reEncryptPinProtectedKeyBackup({
          userPublicId: currentUserPublicId,
          currentPin,
          newPin: pin,
          backup: toBundleDto(latestBackup),
          persistLocally: false,
        });

        const response = await authFetch('/api/v1/e2ee/backup', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            encryptedKeyBlob: reEncrypted.backup.encryptedKeyBlob,
            kdfSalt: reEncrypted.backup.kdfSalt,
            kdfParams: reEncrypted.backup.kdfParams,
            iv: reEncrypted.backup.iv,
            keyFingerprint: reEncrypted.backup.keyFingerprint,
            identityPublicKeyJwk: reEncrypted.publicRegistration.identityPublicKeyJwk,
            signingPublicKeyJwk: reEncrypted.publicRegistration.signingPublicKeyJwk,
            deviceLabel: reEncrypted.publicRegistration.deviceLabel,
          }),
        });

        if (!response.ok) {
          const errBody = (await response.json().catch(() => null)) as ApiErrorBody | null;
          throw new Error(errBody?.error?.message ?? 'Không thể đổi mã PIN lúc này.');
        }

        const data = (await response.json().catch(() => null)) as {
          readonly backup?: E2eeKeyBackupDto;
        } | null;

        await saveDeviceKeyMaterial(reEncrypted.localMaterial, 'backup');
        setSuccessMessage('Đã đổi mã PIN thành công.');
        onClose();
        void Promise.resolve(onCompleted({ mode: 'changed', updatedBackup: data?.backup ?? null }));
        return;
      }

      if (mode === 'forgot' && forgotStep === 'confirm') {
        if (!/^\d{6}$/.test(otpCode)) {
          setErrorMessage('Vui lòng nhập mã xác nhận gồm đúng 6 chữ số từ email.');
          return;
        }
        if (!/^\d{6}$/.test(pin)) {
          setErrorMessage('Vui lòng nhập mã PIN mới gồm đúng 6 chữ số.');
          return;
        }
        if (pin !== confirmPin) {
          setErrorMessage('Mã PIN xác nhận không trùng khớp.');
          return;
        }

        setSubmitting(true);
        const created = await createPinProtectedKeyBackup({
          userPublicId: currentUserPublicId,
          pin,
          persistLocally: false,
        });

        const response = await authFetch('/api/v1/e2ee/backup/reset/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            otpCode,
            encryptedKeyBlob: created.backup.encryptedKeyBlob,
            kdfSalt: created.backup.kdfSalt,
            kdfParams: created.backup.kdfParams,
            iv: created.backup.iv,
            keyFingerprint: created.backup.keyFingerprint,
            identityPublicKeyJwk: created.publicRegistration.identityPublicKeyJwk,
            signingPublicKeyJwk: created.publicRegistration.signingPublicKeyJwk,
            deviceLabel: created.publicRegistration.deviceLabel,
          }),
        });

        if (!response.ok) {
          const errBody = (await response.json().catch(() => null)) as ApiErrorBody | null;
          throw new Error(
            errBody?.error?.message ?? 'Không thể đặt lại mã PIN lúc này. Vui lòng thử lại.',
          );
        }

        const data = (await response.json().catch(() => null)) as {
          readonly backup?: E2eeKeyBackupDto;
        } | null;

        await saveDeviceKeyMaterial(created.localMaterial, 'backup');
        setSuccessMessage('Đã đặt lại mã PIN thành công.');
        onClose();
        void Promise.resolve(onCompleted({ mode: 'reset', updatedBackup: data?.backup ?? null }));
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Không thể thực hiện thao tác. Vui lòng thử lại.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  const modalTitle =
    mode === 'create_mandatory'
      ? 'Tạo mã PIN tin nhắn'
      : mode === 'restore'
        ? 'Đồng bộ tin nhắn cũ'
        : mode === 'change'
          ? 'Đổi mã PIN tin nhắn'
          : 'Đặt lại mã PIN';

  const modalSubtitle =
    mode === 'create_mandatory'
      ? 'Tạo mã PIN 6 chữ số để bảo vệ và đồng bộ lịch sử trò chuyện khi đăng nhập trên thiết bị mới.'
      : mode === 'restore'
        ? 'Nhập mã PIN 6 chữ số để mở khóa và đồng bộ các tin nhắn từ thiết bị trước.'
        : mode === 'change'
          ? 'Toàn bộ lịch sử tin nhắn cũ và mới của bạn sẽ được giữ nguyên sau khi đổi mã PIN.'
          : 'Xác nhận qua email tài khoản để thiết lập mã PIN đồng bộ mới.';

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && canCloseNow) {
          onClose();
        }
      }}
    >
      <div className="w-full max-w-md rounded-2xl border bg-background p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            {mode === 'forgot' && initialMode !== 'forgot' ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Quay lại"
                disabled={submitting || requestingOtp}
                onClick={switchBackFromForgot}
                className="mt-0.5 size-8 shrink-0 rounded-full"
              >
                <ArrowLeft className="size-4" aria-hidden="true" />
              </Button>
            ) : (
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                <KeyRound className="size-5" aria-hidden="true" />
              </div>
            )}
            <div>
              <h2 id={titleId} className="text-base font-semibold text-foreground">
                {modalTitle}
              </h2>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {modalSubtitle}
              </p>
            </div>
          </div>

          {allowClose ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Đóng hộp thoại"
              disabled={!canCloseNow}
              onClick={onClose}
              className="size-8 shrink-0 rounded-full"
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          ) : null}
        </div>

        {mode === 'forgot' && forgotStep === 'warning' ? (
          <div className="mt-4 space-y-4">
            <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-50/80 p-3.5 text-xs leading-relaxed text-amber-950 dark:bg-amber-950/30 dark:text-amber-100">
              <AlertTriangle
                className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
                aria-hidden="true"
              />
              <p>
                Khi đặt lại mã PIN, mã mới sẽ dùng để đồng bộ các tin nhắn từ bây giờ. Những tin
                nhắn trước thời điểm đặt lại sẽ không thể khôi phục trên thiết bị mới.
              </p>
            </div>

            {errorMessage ? (
              <p role="alert" className="text-xs font-medium text-destructive">
                {errorMessage}
              </p>
            ) : null}

            <div className="flex justify-end gap-2 pt-1">
              {allowClose ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={requestingOtp}
                  onClick={onClose}
                >
                  Hủy
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                disabled={requestingOtp || resendCooldownSeconds > 0}
                onClick={() => void handleRequestResetOtp()}
              >
                {requestingOtp ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    <span>Đang gửi mã...</span>
                  </>
                ) : resendCooldownSeconds > 0 ? (
                  <>
                    <Clock className="size-3.5" aria-hidden="true" />
                    <span>Thử lại sau {resendCooldownSeconds}s</span>
                  </>
                ) : (
                  <>
                    <Mail className="size-3.5" aria-hidden="true" />
                    <span>Gửi mã xác nhận</span>
                  </>
                )}
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={(e) => void handleSubmit(e)} className="mt-4 space-y-3.5">
            {mode === 'forgot' && forgotStep === 'confirm' ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2 rounded-xl border bg-muted/40 px-3.5 py-2.5 text-xs">
                  <span className="text-muted-foreground">
                    Mã xác nhận 6 chữ số đã được gửi tới{' '}
                    <strong className="text-foreground">{maskedEmail ?? 'email của bạn'}</strong>.
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={requestingOtp || resendCooldownSeconds > 0 || submitting}
                    onClick={() => void handleRequestResetOtp()}
                    className="h-7 shrink-0 px-2 text-xs"
                  >
                    {resendCooldownSeconds > 0 ? `Gửi lại (${resendCooldownSeconds}s)` : 'Gửi lại'}
                  </Button>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="pin-reset-otp">Mã xác nhận qua email (6 chữ số)</Label>
                  <Input
                    id="pin-reset-otp"
                    name="pinResetOtp"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    placeholder="000000"
                    value={otpCode}
                    onChange={(e) => {
                      setOtpCode(sanitizePinInput(e.target.value));
                      setErrorMessage(null);
                    }}
                    disabled={submitting}
                    className="font-mono text-base tracking-[0.35em]"
                  />
                </div>
              </div>
            ) : null}

            {mode === 'change' ? (
              <div className="space-y-1.5">
                <Label htmlFor="chat-current-pin-input">Mã PIN hiện tại (6 chữ số)</Label>
                <Input
                  id="chat-current-pin-input"
                  name="currentPin"
                  type="password"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  autoComplete="off"
                  placeholder="••••••"
                  value={currentPin}
                  onChange={(e) => {
                    setCurrentPin(sanitizePinInput(e.target.value));
                    setErrorMessage(null);
                  }}
                  disabled={submitting}
                  className="font-mono text-base tracking-[0.35em]"
                />
              </div>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor="chat-pin-input">
                {mode === 'change' || mode === 'forgot'
                  ? 'Mã PIN mới (6 chữ số)'
                  : 'Mã PIN (6 chữ số)'}
              </Label>
              <Input
                id="chat-pin-input"
                name="chatPin"
                type="password"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                autoComplete="off"
                placeholder="••••••"
                value={pin}
                onChange={(e) => {
                  setPin(sanitizePinInput(e.target.value));
                  setErrorMessage(null);
                }}
                disabled={submitting}
                className="font-mono text-base tracking-[0.35em]"
              />
            </div>

            {mode === 'create_mandatory' || mode === 'change' || mode === 'forgot' ? (
              <div className="space-y-1.5">
                <Label htmlFor="chat-pin-confirm">
                  {mode === 'change' || mode === 'forgot'
                    ? 'Xác nhận mã PIN mới'
                    : 'Nhập lại mã PIN'}
                </Label>
                <Input
                  id="chat-pin-confirm"
                  name="chatPinConfirm"
                  type="password"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  autoComplete="off"
                  placeholder="••••••"
                  value={confirmPin}
                  onChange={(e) => {
                    setConfirmPin(sanitizePinInput(e.target.value));
                    setErrorMessage(null);
                  }}
                  disabled={submitting}
                  className="font-mono text-base tracking-[0.35em]"
                />
              </div>
            ) : null}

            {mode === 'create_mandatory' ? (
              <div className="flex items-start gap-2 rounded-xl bg-muted/50 p-3 text-xs text-muted-foreground">
                <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>
                  Chỉ mình bạn biết mã PIN này. Hãy ghi nhớ mã PIN để đồng bộ tin nhắn khi đăng nhập
                  trên thiết bị mới.
                </span>
              </div>
            ) : null}

            {errorMessage ? (
              <p role="alert" className="text-xs font-medium text-destructive">
                {errorMessage}
              </p>
            ) : null}

            {successMessage ? (
              <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="size-4" aria-hidden="true" />
                <span>{successMessage}</span>
              </p>
            ) : null}

            <div className="flex items-center justify-between gap-2 pt-2">
              {mode === 'restore' || mode === 'change' ? (
                <button
                  type="button"
                  disabled={submitting}
                  onClick={switchToForgotMode}
                  className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
                >
                  Quên mã PIN?
                </button>
              ) : (
                <span />
              )}

              <div className="flex items-center gap-2">
                {allowClose ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={submitting}
                    onClick={onClose}
                  >
                    Đóng
                  </Button>
                ) : null}
                <Button
                  type="submit"
                  size="sm"
                  disabled={
                    submitting ||
                    pin.length !== 6 ||
                    (mode === 'change' && (currentPin.length !== 6 || confirmPin.length !== 6)) ||
                    (mode === 'create_mandatory' && confirmPin.length !== 6) ||
                    (mode === 'forgot' && (otpCode.length !== 6 || confirmPin.length !== 6))
                  }
                >
                  {submitting ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                      <span>Đang xử lý...</span>
                    </>
                  ) : mode === 'restore' ? (
                    <span>Đồng bộ ngay</span>
                  ) : mode === 'change' ? (
                    <span>Đổi mã PIN</span>
                  ) : mode === 'forgot' ? (
                    <span>Đặt lại mã PIN</span>
                  ) : (
                    <span>Tạo mã PIN</span>
                  )}
                </Button>
              </div>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
}
