'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
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
import { changePasswordInputSchema } from '@/modules/auth/auth.schemas';

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

interface ChangePasswordSuccessPayload {
  readonly changed: true;
  readonly revokedOtherSessionsCount: number;
  readonly message: string;
}

type SubmitStatus = 'idle' | 'loading' | 'success' | 'error' | 'rate_limited';
type FieldErrors = Partial<
  Record<'currentPassword' | 'newPassword' | 'confirmPassword' | 'otpCode', string>
>;

export interface ChangePasswordCardProps {
  readonly onPasswordChanged?: () => Promise<void> | void;
}

const DEFAULT_OTP_COOLDOWN_SECONDS = 60;

export function ChangePasswordCard({ onPasswordChanged }: ChangePasswordCardProps) {
  const router = useRouter();

  const [currentPassword, setCurrentPassword] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [otpCode, setOtpCode] = React.useState('');

  const [otpRequesting, setOtpRequesting] = React.useState(false);
  const [otpCooldownSeconds, setOtpCooldownSeconds] = React.useState(0);
  const [otpNotice, setOtpNotice] = React.useState<{
    readonly variant: 'success' | 'warning' | 'destructive';
    readonly text: string;
  } | null>(null);

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

  async function handleRequestOtp() {
    if (otpRequesting || otpCooldownSeconds > 0 || status === 'loading') {
      return;
    }

    setOtpRequesting(true);
    setOtpNotice(null);

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
        errorBody.error?.message ?? 'Không thể gửi mã OTP xác nhận. Vui lòng thử lại.';

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
        text: 'Không thể kết nối đến máy chủ để gửi mã OTP. Vui lòng thử lại.',
      });
    } finally {
      setOtpRequesting(false);
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
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
      otpCode,
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
      setBannerMessage(
        'Thông tin đổi mật khẩu chưa hợp lệ. Vui lòng kiểm tra lại các trường bên dưới.',
      );
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
          otpCode,
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
        setStatus('success');
        setBannerMessage(
          data.revokedOtherSessionsCount > 0
            ? `${data.message} (${data.revokedOtherSessionsCount} thiết bị khác đã bị đăng xuất).`
            : data.message,
        );
        // Làm mới lại danh sách thiết bị để phản ánh phiên vừa xoay vòng và các thiết bị khác đã bị thu hồi.
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

  return (
    <Card className="shadow-sm">
      <CardHeader className="border-b pb-4">
        <div className="flex items-center gap-2">
          <KeyRound className="size-5 text-primary" aria-hidden="true" />
          <CardTitle className="text-lg">Đổi mật khẩu</CardTitle>
        </div>
        <CardDescription>
          Yêu cầu xác thực bổ sung qua mã OTP 6 số gửi về email tài khoản (hiệu lực 10 phút). Sau
          khi đổi mật khẩu, tất cả thiết bị khác sẽ bị đăng xuất và phiên hiện tại sẽ được xoay vòng
          an toàn.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5 pt-5">
        <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-0.5 text-sm">
            <p className="font-medium text-foreground">Bước 1: Lấy mã xác nhận OTP qua email</p>
            <p className="text-xs text-muted-foreground">
              Mã OTP có hiệu lực 10 phút, tối đa 5 lần nhập sai và thời gian chờ giữa 2 lần gửi là
              60 giây.
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
                Đang gửi OTP...
              </>
            ) : otpCooldownSeconds > 0 ? (
              <>
                <Clock className="size-4" aria-hidden="true" />
                Gửi lại sau {otpCooldownSeconds}s
              </>
            ) : (
              <>
                <Mail className="size-4" aria-hidden="true" />
                Gửi mã OTP
              </>
            )}
          </Button>
        </div>

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
                <AlertTitle>Tạm giới hạn tần suất đổi mật khẩu</AlertTitle>
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
                <AlertTitle>Đổi mật khẩu chưa thành công</AlertTitle>
                <AlertDescription>{bannerMessage}</AlertDescription>
              </div>
            </Alert>
          ) : null}
        </div>

        <form onSubmit={handleSubmit} noValidate className="space-y-4">
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
                placeholder="12–128 ký tự, không dấu tiếng Việt"
                value={newPassword}
                onChange={(event) => {
                  setNewPassword(event.target.value);
                  clearFieldError('newPassword');
                }}
                disabled={isSubmitting}
                aria-invalid={Boolean(fieldErrors.newPassword)}
                aria-describedby={
                  fieldErrors.newPassword ? 'change-new-password-error' : 'change-new-password-hint'
                }
                required
              />
              {fieldErrors.newPassword ? (
                <p id="change-new-password-error" role="alert" className="text-xs text-destructive">
                  {fieldErrors.newPassword}
                </p>
              ) : (
                <p id="change-new-password-hint" className="text-xs text-muted-foreground">
                  Không trùng mật khẩu cũ, email, họ tên hoặc ID tài khoản.
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

          <div className="space-y-1.5 sm:max-w-xs">
            <Label htmlFor="change-otp-code">Mã xác nhận OTP (6 chữ số)</Label>
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
            <Button type="submit" disabled={isBlocked}>
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
      </CardContent>
    </Card>
  );
}
