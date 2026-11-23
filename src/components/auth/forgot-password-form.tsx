'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertCircle, CheckCircle2, Clock, KeyRound, Loader2, MailCheck } from 'lucide-react';

import { savePendingVerificationHint } from '@/components/auth/pending-verification-storage';
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
import { forgotPasswordInputSchema } from '@/modules/auth/auth.schemas';

interface ApiErrorPayload {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly details?: readonly { readonly field?: string; readonly message: string }[];
  };
}

interface ForgotPasswordSuccessPayload {
  readonly message: string;
  readonly expiresInMinutes: number;
}

type FormStatus = 'idle' | 'loading' | 'success' | 'error' | 'rate_limited';
type FieldErrors = Partial<Record<'email', string>>;

export function ForgotPasswordForm() {
  const router = useRouter();

  const [email, setEmail] = React.useState('');
  const [submittedEmail, setSubmittedEmail] = React.useState('');
  const [status, setStatus] = React.useState<FormStatus>('idle');
  const [errorCode, setErrorCode] = React.useState<string | null>(null);
  const [bannerMessage, setBannerMessage] = React.useState('');
  const [expiresInMinutes, setExpiresInMinutes] = React.useState(15);
  const [fieldErrors, setFieldErrors] = React.useState<FieldErrors>({});
  const [retryAfterSeconds, setRetryAfterSeconds] = React.useState(0);

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

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === 'loading' || retryAfterSeconds > 0) {
      return;
    }

    setFieldErrors({});
    setBannerMessage('');
    setErrorCode(null);

    const clientParsed = forgotPasswordInputSchema.safeParse({ email });
    if (!clientParsed.success) {
      const nextErrors: FieldErrors = {};
      for (const issue of clientParsed.error.issues) {
        if (issue.path[0] === 'email' && !nextErrors.email) {
          nextErrors.email = issue.message;
        }
      }
      setFieldErrors(nextErrors);
      setStatus('error');
      setBannerMessage(nextErrors.email ?? 'Vui lòng nhập địa chỉ email hợp lệ.');
      return;
    }

    setStatus('loading');

    try {
      const response = await fetch('/api/v1/auth/forgot-password', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: clientParsed.data.email,
        }),
      });

      if (response.ok) {
        const data = (await response.json()) as ForgotPasswordSuccessPayload;
        setSubmittedEmail(clientParsed.data.email);
        setExpiresInMinutes(data.expiresInMinutes || 15);
        setStatus('success');
        setBannerMessage(data.message);
        return;
      }

      const errorBody = (await response.json().catch(() => ({}))) as ApiErrorPayload;
      const serverCode = errorBody.error?.code ?? null;
      const serverMessage =
        errorBody.error?.message ?? 'Không thể gửi yêu cầu đặt lại mật khẩu. Vui lòng thử lại.';

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
        if (detail.field === 'email' && !nextErrors.email) {
          nextErrors.email = detail.message;
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

  if (status === 'success') {
    return (
      <Card className="w-full shadow-md">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex size-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
            <MailCheck className="size-6" aria-hidden="true" />
          </div>
          <CardTitle>Kiểm tra hộp thư của bạn</CardTitle>
          <CardDescription>
            Liên kết đặt lại mật khẩu đã được gửi tới{' '}
            <span className="font-medium text-foreground">{submittedEmail}</span>.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <Alert variant="success" aria-live="polite">
            <CheckCircle2 aria-hidden="true" />
            <div>
              <AlertTitle>Đã gửi liên kết khôi phục</AlertTitle>
              <AlertDescription>
                {bannerMessage} Vui lòng mở liên kết trong vòng {expiresInMinutes} phút để tạo mật
                khẩu mới.
              </AlertDescription>
            </div>
          </Alert>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button asChild className="w-full">
              <Link href="/login">Quay lại Đăng nhập</Link>
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => {
                setStatus('idle');
                setBannerMessage('');
                setErrorCode(null);
              }}
            >
              Gửi lại với email khác
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const isSubmitting = status === 'loading';
  const isBlocked = isSubmitting || retryAfterSeconds > 0;

  return (
    <Card className="w-full shadow-md">
      <CardHeader className="space-y-1 text-center">
        <CardTitle>Quên mật khẩu</CardTitle>
        <CardDescription>
          Nhập địa chỉ email tài khoản Tomato của bạn để nhận liên kết đặt lại mật khẩu (có hiệu lực
          trong 15 phút).
        </CardDescription>
      </CardHeader>

      <CardContent>
        <div aria-live="polite" className="mb-4 space-y-3">
          {status === 'rate_limited' ? (
            <Alert variant="warning">
              <Clock aria-hidden="true" />
              <div>
                <AlertTitle>Vui lòng chờ một lát</AlertTitle>
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
            <Alert variant="destructive">
              <AlertCircle aria-hidden="true" />
              <div>
                <AlertTitle>
                  {errorCode === 'NOT_FOUND'
                    ? 'Không tìm thấy tài khoản'
                    : errorCode === 'ACCOUNT_SUSPENDED'
                      ? 'Tài khoản bị tạm đình chỉ'
                      : 'Không thể gửi yêu cầu'}
                </AlertTitle>
                <AlertDescription>
                  {bannerMessage}
                  {errorCode === 'NOT_FOUND' ? (
                    <span className="mt-1.5 block">
                      Bạn chưa có tài khoản?{' '}
                      <Link href="/register" className="font-medium underline">
                        Đăng ký ngay
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
            <Label htmlFor="forgot-email">Địa chỉ email</Label>
            <Input
              id="forgot-email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="ban@example.com"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                if (fieldErrors.email) {
                  setFieldErrors({});
                }
              }}
              disabled={isSubmitting}
              aria-invalid={Boolean(fieldErrors.email)}
              aria-describedby={fieldErrors.email ? 'forgot-email-error' : undefined}
              required
            />
            {fieldErrors.email ? (
              <p id="forgot-email-error" role="alert" className="text-xs text-destructive">
                {fieldErrors.email}
              </p>
            ) : null}
          </div>

          <Button type="submit" size="lg" className="w-full" disabled={isBlocked}>
            {isSubmitting ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Đang gửi liên kết...
              </>
            ) : retryAfterSeconds > 0 ? (
              `Thử lại sau ${retryAfterSeconds}s`
            ) : (
              <>
                <KeyRound className="size-4" aria-hidden="true" />
                Gửi liên kết đặt lại mật khẩu
              </>
            )}
          </Button>
        </form>
      </CardContent>

      <CardFooter className="flex flex-col gap-2 border-t pt-4 text-center text-sm text-muted-foreground">
        <p>
          Nhớ lại mật khẩu rồi?{' '}
          <Link href="/login" className="font-medium text-primary hover:underline">
            Quay lại Đăng nhập
          </Link>
        </p>
      </CardFooter>
    </Card>
  );
}
