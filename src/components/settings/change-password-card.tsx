'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  KeyRound,
  Loader2,
  Mail,
  ShieldCheck,
} from 'lucide-react';

import { PasswordInput } from '@/components/auth/password-input';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authFetch } from '@/lib/auth-client';
import { cn } from '@/lib/utils';
import {
  changePasswordInputSchema,
  verifyPasswordChangeOtpInputSchema,
} from '@/modules/auth/auth.schemas';

interface ApiErrorPayload {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly details?: readonly { readonly field?: string; readonly message: string }[];
  };
}

interface RequestOtpSuccessPayload {
  readonly message: string;
  readonly cooldownSeconds: number;
  readonly expiresInMinutes: number;
}

interface VerifyOtpSuccessPayload {
  readonly verified: true;
  readonly expiresInMinutes: number;
  readonly message: string;
}

interface ChangePasswordSuccessPayload {
  readonly changed: true;
  readonly revokedOtherSessionsCount: number;
  readonly message: string;
}

type WizardStep = 'verify_otp' | 'change_password';
type SubmitStatus = 'idle' | 'loading' | 'success' | 'error' | 'rate_limited';
type FieldErrors = Partial<
  Record<'otpCode' | 'currentPassword' | 'newPassword' | 'confirmPassword', string>
>;

export interface ChangePasswordCardProps {
  readonly onPasswordChanged?: () => Promise<void> | void;
}

const DEFAULT_OTP_COOLDOWN_SECONDS = 60;
const DEFAULT_TICKET_TTL_MINUTES = 10;

function formatCountdown(totalSeconds: number): string {
  const safeSeconds = Math.max(0, totalSeconds);
  const mins = Math.floor(safeSeconds / 60);
  const secs = safeSeconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function ChangePasswordCard({ onPasswordChanged }: ChangePasswordCardProps) {
  const router = useRouter();

  const [step, setStep] = React.useState<WizardStep>('verify_otp');

  // Trạng thái Bước 1: Gửi & Xác minh mã 6 chữ số qua email
  const [otpCode, setOtpCode] = React.useState('');
  const [otpRequesting, setOtpRequesting] = React.useState(false);
  const [otpCooldownSeconds, setOtpCooldownSeconds] = React.useState(0);
  const [otpNotice, setOtpNotice] = React.useState<{
    readonly variant: 'success' | 'warning' | 'destructive';
    readonly text: string;
  } | null>(null);

  // Trạng thái Bước 2: Đổi mật khẩu (chỉ mở khóa sau khi server cấp HttpOnly ticket ở Bước 1)
  const [ticketRemainingSeconds, setTicketRemainingSeconds] = React.useState(0);
  const [currentPassword, setCurrentPassword] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');

  const [status, setStatus] = React.useState<SubmitStatus>('idle');
  const [bannerMessage, setBannerMessage] = React.useState('');
  const [fieldErrors, setFieldErrors] = React.useState<FieldErrors>({});
  const [submitRetryAfterSeconds, setSubmitRetryAfterSeconds] = React.useState(0);

  React.useEffect(() => {
    if (otpCooldownSeconds <= 0) {
      return;
    }
    const timer = window.setInterval(() => {
      setOtpCooldownSeconds((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [otpCooldownSeconds]);

  React.useEffect(() => {
    if (submitRetryAfterSeconds <= 0) {
      return;
    }
    const timer = window.setInterval(() => {
      setSubmitRetryAfterSeconds((prev) => {
        if (prev <= 1) {
          setStatus((current) => (current === 'rate_limited' ? 'idle' : current));
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [submitRetryAfterSeconds]);

  React.useEffect(() => {
    if (step !== 'change_password' || ticketRemainingSeconds <= 0) {
      return;
    }
    const timer = window.setInterval(() => {
      setTicketRemainingSeconds((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [step, ticketRemainingSeconds]);

  const clearFieldError = React.useCallback((field: keyof FieldErrors) => {
    setFieldErrors((prev) => {
      if (!prev[field]) {
        return prev;
      }
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }, []);

  function resetToStepOne(warningMessage?: string) {
    setStep('verify_otp');
    setTicketRemainingSeconds(0);
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setOtpCode('');
    setFieldErrors({});
    if (warningMessage) {
      setStatus('error');
      setBannerMessage(warningMessage);
    } else {
      setStatus('idle');
      setBannerMessage('');
    }
  }

  async function handleRequestOtp() {
    if (otpRequesting || otpCooldownSeconds > 0 || status === 'loading') {
      return;
    }

    setOtpRequesting(true);
    setOtpNotice(null);
    if (status === 'success' || status === 'error') {
      setStatus('idle');
      setBannerMessage('');
    }

    try {
      const response = await authFetch('/api/v1/auth/change-password/request-otp', {
        method: 'POST',
      });

      if (response.status === 401) {
        router.replace('/login?next=/settings/security');
        return;
      }

      if (response.ok) {
        const data = (await response.json()) as RequestOtpSuccessPayload;
        setOtpCooldownSeconds(data.cooldownSeconds || DEFAULT_OTP_COOLDOWN_SECONDS);
        setOtpNotice({
          variant: 'success',
          text: data.message,
        });
        return;
      }

      const errorBody = (await response.json().catch(() => ({}))) as ApiErrorPayload;
      const serverMessage =
        errorBody.error?.message ?? 'Không thể gửi mã xác nhận. Vui lòng thử lại.';

      if (response.status === 429 || errorBody.error?.code === 'RATE_LIMITED') {
        const retryHeader = Number(response.headers.get('Retry-After') ?? '60');
        const waitSeconds =
          Number.isFinite(retryHeader) && retryHeader > 0 ? Math.ceil(retryHeader) : 60;
        setOtpCooldownSeconds(waitSeconds);
        setOtpNotice({
          variant: 'warning',
          text: serverMessage,
        });
        return;
      }

      setOtpNotice({
        variant: 'destructive',
        text: serverMessage,
      });
    } catch {
      setOtpNotice({
        variant: 'destructive',
        text: 'Không thể kết nối đến máy chủ. Vui lòng thử lại.',
      });
    } finally {
      setOtpRequesting(false);
    }
  }

  async function handleVerifyOtpSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === 'loading' || submitRetryAfterSeconds > 0) {
      return;
    }

    setFieldErrors({});
    setBannerMessage('');

    const parsed = verifyPasswordChangeOtpInputSchema.safeParse({ otpCode });
    if (!parsed.success) {
      const otpError = parsed.error.issues[0]?.message ?? 'Vui lòng nhập đủ 6 chữ số.';
      setFieldErrors({ otpCode: otpError });
      setStatus('error');
      setBannerMessage(otpError);
      return;
    }

    setStatus('loading');

    try {
      const response = await authFetch('/api/v1/auth/change-password/verify-otp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ otpCode: parsed.data.otpCode }),
      });

      if (response.status === 401) {
        router.replace('/login?next=/settings/security');
        return;
      }

      if (response.ok) {
        const data = (await response.json()) as VerifyOtpSuccessPayload;
        const ttlMinutes = data.expiresInMinutes || DEFAULT_TICKET_TTL_MINUTES;
        setOtpCode('');
        setOtpNotice(null);
        setFieldErrors({});
        setBannerMessage('');
        setStatus('idle');
        setTicketRemainingSeconds(ttlMinutes * 60);
        setStep('change_password');
        return;
      }

      const errorBody = (await response.json().catch(() => ({}))) as ApiErrorPayload;
      const serverCode = errorBody.error?.code;
      const serverMessage =
        errorBody.error?.message ?? 'Mã xác nhận không đúng hoặc đã hết hạn. Vui lòng thử lại.';

      if (response.status === 429 || serverCode === 'RATE_LIMITED') {
        const retryHeader = Number(response.headers.get('Retry-After') ?? '60');
        const waitSeconds =
          Number.isFinite(retryHeader) && retryHeader > 0 ? Math.ceil(retryHeader) : 60;
        setSubmitRetryAfterSeconds(waitSeconds);
        setStatus('rate_limited');
        setBannerMessage(serverMessage);
        return;
      }

      const nextErrors: FieldErrors = {};
      for (const detail of errorBody.error?.details ?? []) {
        if (detail.field === 'otpCode' && !nextErrors.otpCode) {
          nextErrors.otpCode = detail.message;
        }
      }
      setFieldErrors(nextErrors);
      setStatus('error');
      setBannerMessage(serverMessage);
    } catch {
      setStatus('error');
      setBannerMessage('Không thể kết nối đến máy chủ. Vui lòng kiểm tra mạng và thử lại.');
    }
  }

  async function handleChangePasswordSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === 'loading' || submitRetryAfterSeconds > 0) {
      return;
    }

    setFieldErrors({});
    setBannerMessage('');

    if (newPassword !== confirmPassword) {
      setFieldErrors({ confirmPassword: 'Xác nhận mật khẩu mới không khớp.' });
      setStatus('error');
      setBannerMessage('Mật khẩu xác nhận chưa trùng khớp. Vui lòng kiểm tra lại.');
      return;
    }

    const clientParsed = changePasswordInputSchema.safeParse({
      currentPassword,
      newPassword,
    });
    if (!clientParsed.success) {
      const nextErrors: FieldErrors = {};
      for (const issue of clientParsed.error.issues) {
        const key = issue.path[0] as keyof FieldErrors | undefined;
        if (key && !nextErrors[key]) {
          nextErrors[key] = issue.message;
        }
      }
      setFieldErrors(nextErrors);
      setStatus('error');
      setBannerMessage('Vui lòng kiểm tra lại các trường thông tin bên dưới.');
      return;
    }

    setStatus('loading');

    try {
      const response = await authFetch('/api/v1/auth/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          currentPassword,
          newPassword,
        }),
      });

      if (response.status === 401) {
        router.replace('/login?next=/settings/security');
        return;
      }

      if (response.ok) {
        const data = (await response.json()) as ChangePasswordSuccessPayload;
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
        setOtpCode('');
        setOtpNotice(null);
        setTicketRemainingSeconds(0);
        setStep('verify_otp');
        setStatus('success');
        setBannerMessage(
          data.revokedOtherSessionsCount > 0
            ? `${data.message} (${data.revokedOtherSessionsCount} thiết bị khác đã được đăng xuất).`
            : data.message,
        );
        await onPasswordChanged?.();
        return;
      }

      const errorBody = (await response.json().catch(() => ({}))) as ApiErrorPayload;
      const serverCode = errorBody.error?.code;
      const serverMessage =
        errorBody.error?.message ?? 'Đổi mật khẩu chưa thành công. Vui lòng thử lại.';

      if (response.status === 429 || serverCode === 'RATE_LIMITED') {
        const retryHeader = Number(response.headers.get('Retry-After') ?? '60');
        const waitSeconds =
          Number.isFinite(retryHeader) && retryHeader > 0 ? Math.ceil(retryHeader) : 60;
        setSubmitRetryAfterSeconds(waitSeconds);
        setStatus('rate_limited');
        setBannerMessage(serverMessage);
        return;
      }

      // Nếu ticket Bước 1 hết hạn, không hợp lệ hoặc đã vượt số lần sai mật khẩu hiện tại -> quay về Bước 1.
      if (response.status === 403) {
        resetToStepOne(serverMessage);
        return;
      }

      const nextErrors: FieldErrors = {};
      for (const detail of errorBody.error?.details ?? []) {
        const key = detail.field as keyof FieldErrors | undefined;
        if (key && !nextErrors[key]) {
          nextErrors[key] = detail.message;
        }
      }

      setFieldErrors(nextErrors);
      setStatus('error');
      setBannerMessage(serverMessage);
    } catch {
      setStatus('error');
      setBannerMessage('Không thể kết nối đến máy chủ. Vui lòng kiểm tra mạng và thử lại.');
    }
  }

  const isSubmitting = status === 'loading';
  const isBlocked = isSubmitting || submitRetryAfterSeconds > 0;
  const isStepTwo = step === 'change_password';

  return (
    <Card className="shadow-sm">
      <CardHeader className="border-b pb-4">
        <div className="flex items-center gap-2">
          <KeyRound className="size-5 text-primary" aria-hidden="true" />
          <CardTitle className="text-lg">Đổi mật khẩu</CardTitle>
        </div>
        <CardDescription>
          Xác nhận qua email trước khi đặt mật khẩu mới. Sau khi cập nhật, các thiết bị khác sẽ tự
          động được đăng xuất.
        </CardDescription>

        <ol aria-label="Các bước đổi mật khẩu" className="mt-3 grid grid-cols-2 gap-2 pt-1">
          <li
            className={cn(
              'flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium',
              !isStepTwo
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-emerald-600/30 bg-emerald-50 text-emerald-800',
            )}
          >
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-current/15 text-[11px] font-bold">
              {isStepTwo ? '✓' : '1'}
            </span>
            <span className="truncate">Bước 1: Xác nhận email</span>
          </li>
          <li
            className={cn(
              'flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium',
              isStepTwo
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-border bg-muted/40 text-muted-foreground',
            )}
          >
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-current/15 text-[11px] font-bold">
              2
            </span>
            <span className="truncate">Bước 2: Đặt mật khẩu mới</span>
          </li>
        </ol>
      </CardHeader>

      <CardContent className="space-y-5 pt-5">
        <div aria-live="polite" className="space-y-3">
          {otpNotice ? (
            <Alert variant={otpNotice.variant}>
              {otpNotice.variant === 'success' ? (
                <CheckCircle2 aria-hidden="true" />
              ) : otpNotice.variant === 'warning' ? (
                <Clock aria-hidden="true" />
              ) : (
                <AlertCircle aria-hidden="true" />
              )}
              <AlertDescription className="mt-0">{otpNotice.text}</AlertDescription>
            </Alert>
          ) : null}

          {status === 'success' && bannerMessage ? (
            <Alert variant="success">
              <ShieldCheck aria-hidden="true" />
              <div>
                <AlertTitle>Đã cập nhật mật khẩu</AlertTitle>
                <AlertDescription>{bannerMessage}</AlertDescription>
              </div>
            </Alert>
          ) : null}

          {status === 'rate_limited' && bannerMessage ? (
            <Alert variant="warning">
              <Clock aria-hidden="true" />
              <div>
                <AlertTitle>Vui lòng chờ một lát</AlertTitle>
                <AlertDescription>
                  {bannerMessage}
                  {submitRetryAfterSeconds > 0 ? (
                    <span className="mt-1 block font-medium">
                      Thời gian chờ còn lại: {submitRetryAfterSeconds} giây.
                    </span>
                  ) : null}
                </AlertDescription>
              </div>
            </Alert>
          ) : null}

          {status === 'error' && bannerMessage ? (
            <Alert variant="destructive">
              <AlertCircle aria-hidden="true" />
              <div>
                <AlertTitle>
                  {isStepTwo ? 'Đổi mật khẩu chưa thành công' : 'Xác nhận chưa thành công'}
                </AlertTitle>
                <AlertDescription>{bannerMessage}</AlertDescription>
              </div>
            </Alert>
          ) : null}
        </div>

        {!isStepTwo ? (
          <div className="space-y-5">
            <div className="flex flex-col gap-3 rounded-xl border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-0.5 text-sm">
                <p className="font-medium text-foreground">Nhận mã xác nhận qua email</p>
                <p className="text-xs text-muted-foreground">
                  Chúng tôi sẽ gửi mã gồm 6 chữ số có hiệu lực trong 10 phút tới email tài khoản của
                  bạn.
                </p>
              </div>

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleRequestOtp()}
                disabled={otpRequesting || otpCooldownSeconds > 0 || isSubmitting}
                className="shrink-0"
              >
                {otpRequesting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    Đang gửi mã...
                  </>
                ) : otpCooldownSeconds > 0 ? (
                  <>
                    <Clock className="size-4" aria-hidden="true" />
                    Gửi lại sau {otpCooldownSeconds}s
                  </>
                ) : (
                  <>
                    <Mail className="size-4" aria-hidden="true" />
                    Gửi mã xác nhận
                  </>
                )}
              </Button>
            </div>

            <form onSubmit={handleVerifyOtpSubmit} noValidate className="space-y-4">
              <div className="space-y-1.5 sm:max-w-xs">
                <Label htmlFor="change-otp-code">Mã xác nhận (6 chữ số)</Label>
                <Input
                  id="change-otp-code"
                  name="otpCode"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="000000"
                  maxLength={6}
                  value={otpCode}
                  onChange={(event) => {
                    const digitsOnly = event.target.value.replace(/\D/g, '').slice(0, 6);
                    setOtpCode(digitsOnly);
                    clearFieldError('otpCode');
                  }}
                  disabled={isSubmitting}
                  aria-invalid={Boolean(fieldErrors.otpCode)}
                  aria-describedby={fieldErrors.otpCode ? 'change-otp-code-error' : undefined}
                  className="font-mono text-lg tracking-[0.35em]"
                  required
                />
                {fieldErrors.otpCode ? (
                  <p id="change-otp-code-error" role="alert" className="text-xs text-destructive">
                    {fieldErrors.otpCode}
                  </p>
                ) : null}
              </div>

              <div className="flex justify-end pt-1">
                <Button type="submit" disabled={isBlocked || otpCode.length !== 6}>
                  {isSubmitting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      Đang xác nhận...
                    </>
                  ) : submitRetryAfterSeconds > 0 ? (
                    `Thử lại sau ${submitRetryAfterSeconds}s`
                  ) : (
                    <>
                      <CheckCircle2 className="size-4" aria-hidden="true" />
                      Xác nhận
                    </>
                  )}
                </Button>
              </div>
            </form>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="flex flex-col gap-2 rounded-xl border border-emerald-600/30 bg-emerald-50/80 p-3.5 text-sm text-emerald-900 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="size-4 shrink-0 text-emerald-700" aria-hidden="true" />
                <span>
                  {ticketRemainingSeconds > 0 ? (
                    <>
                      Đã xác nhận email. Thời gian còn lại để đổi mật khẩu:{' '}
                      <strong className="font-mono">
                        {formatCountdown(ticketRemainingSeconds)}
                      </strong>
                    </>
                  ) : (
                    'Thời gian xác nhận đã hết. Vui lòng quay lại Bước 1 để lấy mã mới.'
                  )}
                </span>
              </div>

              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => resetToStepOne()}
                disabled={isSubmitting}
                className="w-fit shrink-0 text-emerald-900 hover:bg-emerald-100"
              >
                <ArrowLeft className="size-3.5" aria-hidden="true" />
                Quay lại Bước 1
              </Button>
            </div>

            <form onSubmit={handleChangePasswordSubmit} noValidate className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="change-current-password">Mật khẩu hiện tại</Label>
                <PasswordInput
                  id="change-current-password"
                  name="currentPassword"
                  autoComplete="current-password"
                  placeholder="Nhập mật khẩu hiện tại"
                  value={currentPassword}
                  onChange={(event) => {
                    setCurrentPassword(event.target.value);
                    clearFieldError('currentPassword');
                  }}
                  disabled={isSubmitting}
                  aria-invalid={Boolean(fieldErrors.currentPassword)}
                  aria-describedby={
                    fieldErrors.currentPassword ? 'change-current-password-error' : undefined
                  }
                  required
                />
                {fieldErrors.currentPassword ? (
                  <p
                    id="change-current-password-error"
                    role="alert"
                    className="text-xs text-destructive"
                  >
                    {fieldErrors.currentPassword}
                  </p>
                ) : null}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="change-new-password">Mật khẩu mới</Label>
                  <PasswordInput
                    id="change-new-password"
                    name="newPassword"
                    autoComplete="new-password"
                    placeholder="Từ 12–128 ký tự, không dấu"
                    value={newPassword}
                    onChange={(event) => {
                      setNewPassword(event.target.value);
                      clearFieldError('newPassword');
                    }}
                    disabled={isSubmitting}
                    aria-invalid={Boolean(fieldErrors.newPassword)}
                    aria-describedby={
                      fieldErrors.newPassword
                        ? 'change-new-password-error'
                        : 'change-new-password-hint'
                    }
                    required
                  />
                  {fieldErrors.newPassword ? (
                    <p
                      id="change-new-password-error"
                      role="alert"
                      className="text-xs text-destructive"
                    >
                      {fieldErrors.newPassword}
                    </p>
                  ) : (
                    <p id="change-new-password-hint" className="text-xs text-muted-foreground">
                      12–128 ký tự, không dấu tiếng Việt, không trùng mật khẩu cũ.
                    </p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="change-confirm-password">Xác nhận mật khẩu mới</Label>
                  <PasswordInput
                    id="change-confirm-password"
                    name="confirmPassword"
                    autoComplete="new-password"
                    placeholder="Nhập lại mật khẩu mới"
                    value={confirmPassword}
                    onChange={(event) => {
                      setConfirmPassword(event.target.value);
                      clearFieldError('confirmPassword');
                    }}
                    disabled={isSubmitting}
                    aria-invalid={Boolean(fieldErrors.confirmPassword)}
                    aria-describedby={
                      fieldErrors.confirmPassword ? 'change-confirm-password-error' : undefined
                    }
                    required
                  />
                  {fieldErrors.confirmPassword ? (
                    <p
                      id="change-confirm-password-error"
                      role="alert"
                      className="text-xs text-destructive"
                    >
                      {fieldErrors.confirmPassword}
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="flex justify-end pt-1">
                <Button type="submit" disabled={isBlocked || ticketRemainingSeconds === 0}>
                  {isSubmitting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      Đang cập nhật mật khẩu...
                    </>
                  ) : submitRetryAfterSeconds > 0 ? (
                    `Thử lại sau ${submitRetryAfterSeconds}s`
                  ) : (
                    <>
                      <KeyRound className="size-4" aria-hidden="true" />
                      Cập nhật mật khẩu
                    </>
                  )}
                </Button>
              </div>
            </form>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
