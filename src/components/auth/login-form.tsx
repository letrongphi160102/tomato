'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertCircle, CheckCircle2, Clock, Loader2, LogIn } from 'lucide-react';

import { PasswordInput } from '@/components/auth/password-input';
import { savePendingVerificationHint } from '@/components/auth/pending-verification-storage';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authFetch } from '@/lib/auth-client';
import { loginInputSchema } from '@/modules/auth/auth.schemas';

interface ApiErrorPayload {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly details?: readonly { readonly field?: string; readonly message: string }[];
  };
}

interface LoginSuccessPayload {
  readonly user: {
    readonly public_id: string;
    readonly username: string;
    readonly fullName: string;
    readonly gender: string;
    readonly status: string;
  };
  readonly message: string;
}

type FormStatus = 'idle' | 'loading' | 'success' | 'error' | 'rate_limited';
type FieldErrors = Partial<Record<'email' | 'password', string>>;

export interface LoginFormProps {
  readonly nextPath: string;
}

export function LoginForm({ nextPath }: LoginFormProps) {
  const router = useRouter();

  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');

  const [checkingSession, setCheckingSession] = React.useState(true);
  const [status, setStatus] = React.useState<FormStatus>('idle');
  const [errorCode, setErrorCode] = React.useState<string | null>(null);
  const [bannerMessage, setBannerMessage] = React.useState('');
  const [fieldErrors, setFieldErrors] = React.useState<FieldErrors>({});
  const [retryAfterSeconds, setRetryAfterSeconds] = React.useState(0);

  // Tự động kiểm tra phiên hiện có (bao gồm gọi `/refresh` nếu AT vừa hết hạn 15 phút).
  React.useEffect(() => {
    let active = true;

    async function checkExistingSession() {
      try {
        const res = await authFetch('/api/v1/auth/me', { method: 'GET' });
        if (active && res.ok) {
          router.replace(nextPath);
          return;
        }
      } catch {
        // Bỏ qua lỗi mạng nền; cho phép người dùng đăng nhập thủ công.
      } finally {
        if (active) {
          setCheckingSession(false);
        }
      }
    }

    void checkExistingSession();
    return () => {
      active = false;
    };
  }, [nextPath, router]);

  React.useEffect(() => {
    if (retryAfterSeconds <= 0) {
      return;
    }
    const timer = window.setInterval(() => {
      setRetryAfterSeconds((prev) => {
        if (prev <= 1) {
          setStatus((current) => (current === 'rate_limited' ? 'idle' : current));
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [retryAfterSeconds]);

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

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === 'loading' || retryAfterSeconds > 0 || status === 'success') {
      return;
    }

    setFieldErrors({});
    setBannerMessage('');
    setErrorCode(null);

    const clientParsed = loginInputSchema.safeParse({ email, password });
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
      setBannerMessage('Vui lòng nhập đầy đủ địa chỉ email và mật khẩu.');
      return;
    }

    setStatus('loading');

    try {
      const response = await fetch('/api/v1/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          password,
        }),
      });

      if (response.ok) {
        const data = (await response.json()) as LoginSuccessPayload;
        setStatus('success');
        setBannerMessage(data.message);
        router.replace(nextPath);
        router.refresh();
        return;
      }

      const errorBody = (await response.json().catch(() => ({}))) as ApiErrorPayload;
      const serverCode = errorBody.error?.code ?? null;
      const serverMessage =
        errorBody.error?.message ?? 'Đăng nhập không thành công. Vui lòng thử lại.';

      if (response.status === 429 || serverCode === 'RATE_LIMITED') {
        const retryHeader = Number(response.headers.get('Retry-After') ?? '60');
        const waitSeconds =
          Number.isFinite(retryHeader) && retryHeader > 0 ? Math.ceil(retryHeader) : 60;
        setRetryAfterSeconds(waitSeconds);
        setStatus('rate_limited');
        setErrorCode('RATE_LIMITED');
        setBannerMessage(serverMessage);
        return;
      }

      // Nếu tài khoản chưa xác minh email, lưu email tạm vào sessionStorage và chuyển thẳng sang trang nhập OTP.
      if (serverCode === 'EMAIL_NOT_VERIFIED') {
        savePendingVerificationHint({
          email: clientParsed.data.email,
          savedAt: Date.now(),
          sentAt: 0,
          notice: serverMessage,
        });
        router.push('/verify-email');
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
      setErrorCode(serverCode);
      setStatus('error');
      setBannerMessage(serverMessage);
    } catch {
      setStatus('error');
      setErrorCode(null);
      setBannerMessage('Không thể kết nối đến máy chủ. Vui lòng kiểm tra mạng và thử lại.');
    }
  }

  if (checkingSession) {
    return (
      <Card className="w-full shadow-md">
        <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-center">
          <Loader2 className="size-6 animate-spin text-primary" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">
            Đang kiểm tra trạng thái phiên đăng nhập...
          </p>
        </CardContent>
      </Card>
    );
  }

  const isSubmitting = status === 'loading';
  const isBlocked = isSubmitting || retryAfterSeconds > 0 || status === 'success';

  return (
    <Card className="w-full shadow-md">
      <CardHeader className="space-y-1 text-center">
        <CardTitle>Đăng nhập vào Tomato</CardTitle>
      </CardHeader>

      <CardContent>
        <div aria-live="polite" className="mb-4 space-y-3">
          {status === 'success' ? (
            <Alert variant="success">
              <CheckCircle2 aria-hidden="true" />
              <div>
                <AlertTitle>Đăng nhập thành công</AlertTitle>
                <AlertDescription>{bannerMessage} Đang chuyển hướng...</AlertDescription>
              </div>
            </Alert>
          ) : null}

          {status === 'rate_limited' ? (
            <Alert variant="warning">
              <Clock aria-hidden="true" />
              <div>
                <AlertTitle>Tạm giới hạn tần suất đăng nhập</AlertTitle>
                <AlertDescription>
                  {bannerMessage}
                  {retryAfterSeconds > 0 ? (
                    <span className="mt-1 block font-medium">
                      Thời gian chờ còn lại: {retryAfterSeconds} giây.
                    </span>
                  ) : null}
                </AlertDescription>
              </div>
            </Alert>
          ) : null}

          {status === 'error' && bannerMessage ? (
            <Alert variant={errorCode === 'ACCOUNT_LOCKED' ? 'warning' : 'destructive'}>
              <AlertCircle aria-hidden="true" />
              <div>
                <AlertTitle>
                  {errorCode === 'ACCOUNT_LOCKED'
                    ? 'Tài khoản đang tạm khóa'
                    : errorCode === 'ACCOUNT_SUSPENDED'
                      ? 'Tài khoản bị tạm đình chỉ'
                      : 'Đăng nhập không thành công'}
                </AlertTitle>
                <AlertDescription>
                  {bannerMessage}
                  {errorCode === 'ACCOUNT_LOCKED' ? (
                    <span className="mt-1.5 block">
                      <Link href="/forgot-password" className="font-medium underline">
                        Đặt lại mật khẩu để mở khóa tài khoản
                      </Link>
                    </span>
                  ) : null}
                </AlertDescription>
              </div>
            </Alert>
          ) : null}
        </div>

        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="login-email">Địa chỉ email</Label>
            <Input
              id="login-email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="ban@example.com"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                clearFieldError('email');
              }}
              disabled={isSubmitting}
              aria-invalid={Boolean(fieldErrors.email)}
              aria-describedby={fieldErrors.email ? 'login-email-error' : undefined}
              required
            />
            {fieldErrors.email ? (
              <p id="login-email-error" role="alert" className="text-xs text-destructive">
                {fieldErrors.email}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="login-password">Mật khẩu</Label>
              <Link
                href="/forgot-password"
                className="text-xs font-medium text-primary hover:underline"
              >
                Quên mật khẩu?
              </Link>
            </div>
            <PasswordInput
              id="login-password"
              name="password"
              autoComplete="current-password"
              placeholder="Mật khẩu"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                clearFieldError('password');
              }}
              disabled={isSubmitting}
              aria-invalid={Boolean(fieldErrors.password)}
              aria-describedby={fieldErrors.password ? 'login-password-error' : undefined}
              required
            />
            {fieldErrors.password ? (
              <p id="login-password-error" role="alert" className="text-xs text-destructive">
                {fieldErrors.password}
              </p>
            ) : null}
          </div>

          <Button type="submit" size="lg" className="w-full" disabled={isBlocked}>
            {isSubmitting ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Đang xác thực...
              </>
            ) : retryAfterSeconds > 0 ? (
              `Thử lại sau ${retryAfterSeconds}s`
            ) : (
              <>
                <LogIn className="size-4" aria-hidden="true" />
                Đăng nhập
              </>
            )}
          </Button>
        </form>
      </CardContent>

      <CardFooter className="flex flex-col gap-2 border-t pt-4 text-center text-sm text-muted-foreground">
        <p>
          Chưa có tài khoản TOMATO?{' '}
          <Link href="/register" className="font-medium text-primary hover:underline">
            Đăng ký ngay
          </Link>
        </p>
      </CardFooter>
    </Card>
  );
}
