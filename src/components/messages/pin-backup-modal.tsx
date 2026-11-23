'use client';

import * as React from 'react';
import { CheckCircle2, KeyRound, Loader2, Lock, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authFetch } from '@/lib/auth-client';
import {
  markE2eeDeviceFingerprintRegistered,
  setCachedServerKeyBackupInSession,
} from '@/lib/e2ee/client-bootstrap';
import {
  createPinProtectedKeyBackup,
  restorePinProtectedKeyBackup,
  type EncryptedKeyBackupBundleDto,
} from '@/lib/e2ee/pin-backup';
import type { E2eeKeyBackupDto } from '@/modules/chat';

export interface PinBackupModalProps {
  readonly open: boolean;
  readonly currentUserPublicId: string;
  readonly existingBackup: E2eeKeyBackupDto | null;
  readonly hasLocalRestoredBackup: boolean;
  readonly onClose: () => void;
  readonly onBackupSynced: () => void;
}

export function PinBackupModal({
  open,
  currentUserPublicId,
  existingBackup,
  hasLocalRestoredBackup,
  onClose,
  onBackupSynced,
}: PinBackupModalProps) {
  const [mode, setMode] = React.useState<'restore' | 'create'>(
    existingBackup && !hasLocalRestoredBackup ? 'restore' : 'create',
  );
  const [pin, setPin] = React.useState('');
  const [confirmPin, setConfirmPin] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [successMessage, setSuccessMessage] = React.useState<string | null>(null);

  if (!open) {
    return null;
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) {
      return;
    }

    const cleanPin = pin.trim();
    if (!/^\d{6}$/.test(cleanPin)) {
      setErrorMessage('Vui lòng nhập mã PIN gồm đúng 6 chữ số.');
      return;
    }

    if (mode === 'create' && cleanPin !== confirmPin.trim()) {
      setErrorMessage('Mã PIN xác nhận không trùng khớp.');
      return;
    }

    setSubmitting(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      if (mode === 'restore' && existingBackup) {
        const bundle: EncryptedKeyBackupBundleDto = {
          encryptedKeyBlob: existingBackup.encryptedKeyBlob,
          kdfSalt: existingBackup.kdfSalt,
          kdfParams: existingBackup.kdfParams,
          iv: existingBackup.iv,
          keyFingerprint: existingBackup.keyFingerprint,
          version: 1,
        };

        const restored = await restorePinProtectedKeyBackup({
          userPublicId: currentUserPublicId,
          pin: cleanPin,
          backup: bundle,
        });

        await authFetch('/api/v1/e2ee/devices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identityPublicKeyJwk: restored.identityPublicKeyJwk,
            signingPublicKeyJwk: restored.signingPublicKeyJwk,
            keyFingerprint: restored.keyFingerprint,
            deviceLabel: 'Khóa đồng bộ tin nhắn',
          }),
        });

        markE2eeDeviceFingerprintRegistered(currentUserPublicId, restored.keyFingerprint);
        setSuccessMessage('Đã đồng bộ tin nhắn thành công trên thiết bị này.');
        onBackupSynced();
        setTimeout(() => onClose(), 900);
        return;
      }

      const created = await createPinProtectedKeyBackup({
        userPublicId: currentUserPublicId,
        pin: cleanPin,
      });

      const [backupRes, deviceRes] = await Promise.all([
        authFetch('/api/v1/e2ee/backup', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(created.backup),
        }),
        authFetch('/api/v1/e2ee/devices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(created.publicRegistration),
        }),
      ]);

      if (!backupRes.ok || !deviceRes.ok) {
        const errBody = (await backupRes.json().catch(() => null)) as {
          readonly error?: { readonly message?: string };
        } | null;
        throw new Error(errBody?.error?.message ?? 'Không thể lưu mã PIN lúc này.');
      }

      const savedBackupBody = (await backupRes.json().catch(() => null)) as {
        readonly backup?: E2eeKeyBackupDto;
      } | null;
      if (savedBackupBody?.backup) {
        setCachedServerKeyBackupInSession(currentUserPublicId, savedBackupBody.backup);
      }
      markE2eeDeviceFingerprintRegistered(
        currentUserPublicId,
        created.publicRegistration.keyFingerprint,
      );

      setSuccessMessage('Đã thiết lập mã PIN đồng bộ tin nhắn thành công.');
      onBackupSynced();
      setTimeout(() => onClose(), 900);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Không thể thực hiện thao tác. Vui lòng thử lại.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="pin-backup-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs"
    >
      <div className="w-full max-w-md rounded-2xl border bg-background p-6 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
              <KeyRound className="size-5" aria-hidden="true" />
            </div>
            <div>
              <h2 id="pin-backup-modal-title" className="text-base font-semibold text-foreground">
                {mode === 'restore' ? 'Đồng bộ tin nhắn cũ' : 'Mã PIN bảo vệ tin nhắn'}
              </h2>
              <p className="text-xs text-muted-foreground">
                Giúp bạn đọc lại lịch sử trò chuyện khi đăng nhập trên trình duyệt mới
              </p>
            </div>
          </div>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Đóng hộp thoại"
            disabled={submitting}
            onClick={onClose}
            className="size-8 rounded-full"
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>

        {existingBackup ? (
          <div className="mt-4 flex gap-1 rounded-xl bg-muted p-1">
            <button
              type="button"
              onClick={() => {
                setMode('restore');
                setErrorMessage(null);
              }}
              className={`flex-1 rounded-lg py-1.5 text-xs font-medium transition-colors ${
                mode === 'restore'
                  ? 'bg-background text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Nhập mã PIN hiện có
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('create');
                setErrorMessage(null);
              }}
              className={`flex-1 rounded-lg py-1.5 text-xs font-medium transition-colors ${
                mode === 'create'
                  ? 'bg-background text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Đặt mã PIN mới
            </button>
          </div>
        ) : null}

        <form onSubmit={(e) => void handleSubmit(e)} className="mt-4 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="chat-pin-input">Mã PIN 6 chữ số</Label>
            <Input
              id="chat-pin-input"
              type="password"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              autoComplete="off"
              placeholder="••••••"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              disabled={submitting}
            />
          </div>

          {mode === 'create' ? (
            <div className="space-y-1.5">
              <Label htmlFor="chat-pin-confirm">Nhập lại mã PIN 6 chữ số</Label>
              <Input
                id="chat-pin-confirm"
                type="password"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                autoComplete="off"
                placeholder="••••••"
                value={confirmPin}
                onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                disabled={submitting}
              />
            </div>
          ) : null}

          <div className="flex items-start gap-2 rounded-xl bg-muted/50 p-3 text-xs text-muted-foreground">
            <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>
              Chỉ mình bạn biết mã PIN này. Hãy ghi nhớ mã PIN để khôi phục tin nhắn khi sử dụng máy
              mới.
            </span>
          </div>

          {errorMessage ? (
            <p role="alert" className="text-xs font-medium text-destructive">
              {errorMessage}
            </p>
          ) : null}

          {successMessage ? (
            <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-600">
              <CheckCircle2 className="size-4" aria-hidden="true" />
              <span>{successMessage}</span>
            </p>
          ) : null}

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={submitting}
              onClick={onClose}
            >
              Đóng
            </Button>
            <Button type="submit" size="sm" disabled={submitting || pin.length !== 6}>
              {submitting ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  <span>Đang xử lý...</span>
                </>
              ) : mode === 'restore' ? (
                <span>Đồng bộ ngay</span>
              ) : (
                <span>Lưu mã PIN</span>
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
