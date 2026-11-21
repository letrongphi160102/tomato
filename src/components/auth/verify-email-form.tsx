'use client';

import * as React from 'react';
import Link from 'next/link';
import { AlertCircle, CheckCircle2, Clock, Loader2, MailCheck, RotateCw } from 'lucide-react';

import {
  clearPendingVerificationHint,
  loadPendingVerificationHint,
  subscribePendingVerificationHint,
} from '@/components/auth/pending-verification-storage';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { verifyEmailInputSchema } from '@/modules/auth/auth.schemas';

interface ApiErrorPayload {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly details?: readonly { readonly field?: string; readonly message: string }[];
  };
}

interface VerifySuccessPayload {
  readonly verified: true;
  readonly message: string;
}

interface ResendSuccessPayload {
  readonly message: string;
  readonly cooldownSeconds: number;
}

type VerifyStatus = 'idle' | 'loading' | 'success' | 'error' | 'rate_limited';
type FieldErrors = Partial<Record<'email' | 'otpCode', string>>;

const DEFAULT_COOLDOWN_SECONDS = 60;

const getServerPendingHint = () => null;

export function VerifyEmailForm() {
  const pendingHint = React.useSyncExternalStore(
    subscribePendingVerificationHint,
    loadPendingVerificationHint,
    getServerPendingHint,
  );

  const [emailInput, setEmailInput] = React.useState<string | null>(null);
  const [otpCode, setOtpCode] = React.useState('');

  const [status, setStatus] = React.useState<VerifyStatus>('idle');
  const [bannerMessage, setBannerMessage] = React.useState('');
  const [fieldErrors, setFieldErrors] = React.useState<FieldErrors>({});
  const [verifyRetryAfter, setVerifyRetryAfter] = React.useState(0);

  const [resendLoading, setResendLoading] = React.useState(false);
  const [manualCooldownEndsAt, setManualCooldownEndsAt] = React.useState(0);
  const [clockNowMs, setClockNowMs] = React.useState(() => Date.now());
  const [resendNotice, setResendNotice] = React.useState<{
    readonly variant: 'success' | 'warning' | 'destructive';
    readonly text: string;
  } | null>(null);

  const email = emailInput ?? pendingHint?.email ?? '';
  const initialNotice = pendingHint?.notice ?? '';

  const hintCooldownEndsAt = pendingHint ? pendingHint.sentAt + DEFAULT_COOLDOWN_SECONDS * 1000 : 0;
  const effectiveCooldownEndsAt = Math.max(hintCooldownEndsAt, manualCooldownEndsAt);
  const resendCooldown = Math.max(0, Math.ceil((effectiveCooldownEndsAt - clockNowMs) / 1000));

  React.useEffect(() => {
    if (resendCooldown <= 0) {
      return;
    }
    const timer = window.setInterval(() => {
      setClockNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendCooldown]);

  React.useEffect(() => {
    if (verifyRetryAfter <= 0) {
      return;
    }
    const timer = window.setInterval(() => {
      setVerifyRetryAfter((prev) => {
        if (prev <= 1) {
          setStatus((current) => (current === 'rate_limited' ? 'idle' : current));
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [verifyRetryAfter]);

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

  async function handleVerifySubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === 'loading' || verifyRetryAfter > 0 || status === 'success') {
      return;
    }

    setFieldErrors({});
    setBannerMessage('');

    const parsed = verifyEmailInputSchema.safeParse({ email, otpCode });
    if (!parsed.success) {
      const nextErrors: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof FieldErrors | undefined;
        if (key && !nextErrors[key]) {
          nextErrors[key] = issue.message;
        }
      }
      setFieldErrors(nextErrors);
      setStatus('error');
      setBannerMessage('Vui lòng nhập đầy đủ email hợp lệ và mã OTP gồm 6 chữ số.');
      return;
    }

    setStatus('loading');

    try {
      const response = await fetch('/api/v1/auth/verify-email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(parsed.data),
      });

      if (response.ok) {
        const data = (await response.json()) as VerifySuccessPayload;
        clearPendingVerificationHint();
        setStatus('success');
        setBannerMessage(data.message);
        setResendNotice(null);
        return;
      }

      const errorBody = (await response.json().catch(() => ({}))) as ApiErrorPayload;
      const serverCode = errorBody.error?.code;
      const serverMessage =
        errorBody.error?.message ?? 'Xác minh thất bại. Vui lòng kiểm tra lại mã OTP.';

      if (response.status === 429 || serverCode === 'RATE_LIMITED') {
        const retryHeader = Number(response.headers.get('Retry-After') ?? '60');
        const waitSeconds =
          Number.isFinite(retryHeader) && retryHeader > 0 ? Math.ceil(retryHeader) : 60;
        setVerifyRetryAfter(waitSeconds);
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

  async function handleResendOtp() {
    if (resendLoading || resendCooldown > 0 || status === 'success') {
      return;
    }

    setResendNotice(null);

    if (!email.trim()) {
      setFieldErrors((prev) => ({
        ...prev,
        email: 'Vui lòng nhập địa chỉ email trước khi yêu cầu gửi lại mã.',
      }));
      return;
    }

    setResendLoading(true);
    try {
      const response = await fetch('/api/v1/auth/resend-verification', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email }),
      });

      if (response.ok) {
        const data = (await response.json()) as ResendSuccessPayload;
        const now = Date.now();
        setClockNowMs(now);
        setManualCooldownEndsAt(now + (data.cooldownSeconds || DEFAULT_COOLDOWN_SECONDS) * 1000);
        setResendNotice({ variant: 'success', text: data.message });
        setOtpCode('');
        return;
      }

      const errorBody = (await response.json().catch(() => ({}))) as ApiErrorPayload;
      const serverMessage =
        errorBody.error?.message ?? 'Không thể gửi lại mã xác minh. Vui lòng thử lại.';

      if (response.status === 429 || errorBody.error?.code === 'RATE_LIMITED') {
        const retryHeader = Number(response.headers.get('Retry-After') ?? '60');
        const waitSeconds =
          Number.isFinite(retryHeader) && retryHeader > 0 ? Math.ceil(retryHeader) : 60;
        const now = Date.now();
        setClockNowMs(now);
        setManualCooldownEndsAt(now + waitSeconds * 1000);
        setResendNotice({
          variant: 'warning',
          text: `${serverMessage} (chờ ${waitSeconds} giây)`,
        });
        return;
      }

      setResendNotice({ variant: 'destructive', text: serverMessage });
    } catch {
      setResendNotice({
        variant: 'destructive',
        text: 'Không thể kết nối đến máy chủ khi gửi lại mã.',
      });
    } finally {
      setResendLoading(false);
    }
  }

  if (status === 'success') {
    return (
      <Card className="w-full shadow-md">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex size-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
            <MailCheck className="size-6" aria-hidden="true" />
          </div>
          <CardTitle>Xác minh email thành công</CardTitle>
          <CardDescription>{bannerMessage}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="success" aria-live="polite">
            <CheckCircle2 aria-hidden="true" />
            <div>
              <AlertTitle>Tài khoản đã ở trạng thái hoạt động (Active)</AlertTitle>
              <AlertDescription>
                Địa chỉ email của bạn đã được xác nhận. Luồng Đăng nhập &amp; Quản lý Phiên sẽ mở
                tiếp tại Cột mốc M3.
              </AlertDescription>
            </div>
          </Alert>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button asChild className="w-full">
              <Link href="/">Về trang chủ TOMATO</Link>
            </Button>
            <Button asChild variant="outline" className="w-full">
              <Link href="/register">Đăng ký tài khoản khác</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const isSubmitting = status === 'loading';

  return (
    <Card className="w-full shadow-md">
      <CardHeader className="space-y-1">
        <CardTitle>Xác minh địa chỉ email</CardTitle>
        <CardDescription>
          Nhập mã OTP gồm 6 chữ số đã được gửi tới hộp thư của bạn. Mã có hiệu lực trong 15 phút.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <div aria-live="polite" className="mb-4 space-y-3">
          {initialNotice && status === 'idle' ? (
            <Alert variant="success">
              <CheckCircle2 aria-hidden="true" />
              <div>
                <AlertTitle>Kiểm tra hộp thư của bạn</AlertTitle>
                <AlertDescription>{initialNotice}</AlertDescription>
              </div>
            </Alert>
          ) : null}

          {status === 'rate_limited' ? (
            <Alert variant="warning">
              <Clock aria-hidden="true" />
              <div>
                <AlertTitle>Tạm giới hạn tần suất xác minh</AlertTitle>
                <AlertDescription>
                  {bannerMessage}
                  {verifyRetryAfter > 0 ? (
                    <span className="mt-1 block font-medium">
                      Thời gian chờ còn lại: {verifyRetryAfter} giây.
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
                <AlertTitle>Xác minh chưa thành công</AlertTitle>
                <AlertDescription>{bannerMessage}</AlertDescription>
              </div>
            </Alert>
          ) : null}

          {resendNotice ? (
            <Alert variant={resendNotice.variant}>
              {resendNotice.variant === 'success' ? (
                <CheckCircle2 aria-hidden="true" />
              ) : resendNotice.variant === 'warning' ? (
                <Clock aria-hidden="true" />
              ) : (
                <AlertCircle aria-hidden="true" />
              )}
              <AlertDescription className="mt-0">{resendNotice.text}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <form onSubmit={handleVerifySubmit} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="verify-email">Địa chỉ email</Label>
            <Input
              id="verify-email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="ban@example.com"
              value={email}
              onChange={(event) => {
                setEmailInput(event.target.value);
                clearFieldError('email');
              }}
              disabled={isSubmitting}
              aria-invalid={Boolean(fieldErrors.email)}
              aria-describedby={fieldErrors.email ? 'verify-email-error' : undefined}
              required
            />
            {fieldErrors.email ? (
              <p id="verify-email-error" role="alert" className="text-xs text-destructive">
                {fieldErrors.email}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="otpCode">Mã xác minh OTP (6 chữ số)</Label>
            <Input
              id="otpCode"
              name="otpCode"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              maxLength={6}
              value={otpCode}
              onChange={(event) => {
                // Tự động lọc chỉ giữ chữ số để hỗ trợ dán trực tiếp từ email (ví dụ "123 456").
                const digitsOnly = event.target.value.replace(/\D/g, '').slice(0, 6);
                setOtpCode(digitsOnly);
                clearFieldError('otpCode');
              }}
              disabled={isSubmitting}
              aria-invalid={Boolean(fieldErrors.otpCode)}
              aria-describedby={fieldErrors.otpCode ? 'otpCode-error' : 'otpCode-hint'}
              className="text-center font-mono text-2xl tracking-[0.4em]"
              required
            />
            {fieldErrors.otpCode ? (
              <p id="otpCode-error" role="alert" className="text-xs text-destructive">
                {fieldErrors.otpCode}
              </p>
            ) : (
              <p id="otpCode-hint" className="text-xs text-muted-foreground">
                Tối đa 5 lần nhập sai cho mỗi mã. Sau 5 lần sai mã sẽ bị hủy ngay lập tức.
              </p>
            )}
          </div>

          <Button
            type="submit"
            size="lg"
            className="w-full"
            disabled={isSubmitting || verifyRetryAfter > 0}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Đang xác minh...
              </>
            ) : verifyRetryAfter > 0 ? (
              `Thử lại sau ${verifyRetryAfter}s`
            ) : (
              'Xác minh email'
            )}
          </Button>
        </form>

        <div className="mt-5 flex flex-col items-center gap-2 border-t pt-4">
          <p className="text-xs text-muted-foreground">
            Chưa nhận được email hoặc mã đã hết hạn? (Tối đa 5 lần/giờ)
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleResendOtp}
            disabled={resendLoading || resendCooldown > 0 || isSubmitting}
          >
            {resendLoading ? (
              <>
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                Đang gửi lại mã...
              </>
            ) : resendCooldown > 0 ? (
              <>
                <Clock className="size-3.5" aria-hidden="true" />
                Gửi lại mã sau {resendCooldown}s
              </>
            ) : (
              <>
                <RotateCw className="size-3.5" aria-hidden="true" />
                Gửi lại mã xác minh
              </>
            )}
          </Button>
        </div>
      </CardContent>

      <CardFooter className="flex justify-center border-t pt-4 text-sm text-muted-foreground">
        <Link href="/register" className="font-medium text-primary hover:underline">
          Quay lại trang Đăng ký
        </Link>
      </CardFooter>
    </Card>
  );
}
