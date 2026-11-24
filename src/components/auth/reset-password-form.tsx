'use client';

import * as React from 'react';
import Link from 'next/link';
import { AlertCircle, CheckCircle2, Clock, KeyRound, Loader2, ShieldAlert } from 'lucide-react';

import { PasswordInput } from '@/components/auth/password-input';
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
import { Label } from '@/components/ui/label';
import { resetPasswordInputSchema } from '@/modules/auth/auth.schemas';

interface ApiErrorPayload {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly details?: readonly { readonly field?: string; readonly message: string }[];
  };
}

interface ResetPasswordSuccessPayload {
  readonly reset: true;
  readonly message: string;
}

type FormStatus = 'idle' | 'loading' | 'success' | 'error' | 'rate_limited';
type FieldErrors = Partial<Record<'newPassword' | 'confirmPassword', string>>;

// Lưu tạm token đặt lại mật khẩu duy nhất trong bộ nhớ JS (tuyệt đối không lưu localStorage/sessionStorage)
// để đọc đồng bộ qua `useSyncExternalStore` và xóa ngay `?token=` khỏi browser history mà không gây cascading render.
let inMemoryResetToken: string | null = null;
const resetTokenListeners = new Set<() => void>();

function notifyResetTokenListeners(): void {
  for (const listener of resetTokenListeners) {
    listener();
  }
}

function subscribeResetToken(listener: () => void): () => void {
  resetTokenListeners.add(listener);
  return () => {
    resetTokenListeners.delete(listener);
  };
}

function getClientResetTokenSnapshot(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const params = new URLSearchParams(window.location.search);
  const tokenFromQuery = params.get('token')?.trim() ?? '';
  if (tokenFromQuery) {
    inMemoryResetToken = tokenFromQuery;
  } else if (inMemoryResetToken === null) {
    inMemoryResetToken = '';
  }
  return inMemoryResetToken;
}

function clearInMemoryResetToken(): void {
  inMemoryResetToken = '';
  notifyResetTokenListeners();
}

const getServerResetTokenSnapshot = (): string | null => null;

export function ResetPasswordForm() {
  const tokenSnapshot = React.useSyncExternalStore(
    subscribeResetToken,
    getClientResetTokenSnapshot,
    getServerResetTokenSnapshot,
  );
  const tokenInitialized = tokenSnapshot !== null;
  const resetToken = tokenSnapshot ?? '';

  const [newPassword, setNewPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');

  const [status, setStatus] = React.useState<FormStatus>('idle');
  const [errorCode, setErrorCode] = React.useState<string | null>(null);
  const [bannerMessage, setBannerMessage] = React.useState('');
  const [fieldErrors, setFieldErrors] = React.useState<FieldErrors>({});
  const [retryAfterSeconds, setRetryAfterSeconds] = React.useState(0);

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('token')) {
      // Xóa ngay query `?token=...` khỏi thanh địa chỉ và browser history để tránh rò rỉ qua Referer / lịch sử trình duyệt.
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

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

    if (newPassword !== confirmPassword) {
      setFieldErrors({ confirmPassword: 'Xác nhận mật khẩu mới không khớp.' });
      setStatus('error');
      setBannerMessage('Mật khẩu xác nhận chưa trùng khớp. Vui lòng kiểm tra lại.');
      return;
    }

    const clientParsed = resetPasswordInputSchema.safeParse({
      token: resetToken,
      newPassword,
    });
    if (!clientParsed.success) {
      const nextErrors: FieldErrors = {};
      let tokenIssueMessage: string | null = null;
      for (const issue of clientParsed.error.issues) {
        if (issue.path[0] === 'newPassword' && !nextErrors.newPassword) {
          nextErrors.newPassword = issue.message;
        } else if (issue.path[0] === 'token' && !tokenIssueMessage) {
          tokenIssueMessage = issue.message;
        }
      }
      setFieldErrors(nextErrors);
      setErrorCode(tokenIssueMessage ? 'TOKEN_INVALID' : 'VALIDATION_ERROR');
      setStatus('error');
      setBannerMessage(
        nextErrors.newPassword ??
          tokenIssueMessage ??
          'Thông tin nhập vào chưa hợp lệ. Vui lòng kiểm tra lại.',
      );
      return;
    }

    setStatus('loading');

    try {
      const response = await fetch('/api/v1/auth/reset-password', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          token: resetToken,
          newPassword,
        }),
      });

      if (response.ok) {
        const data = (await response.json()) as ResetPasswordSuccessPayload;
        // Xóa sạch mật khẩu và token khỏi bộ nhớ trình duyệt ngay khi hoàn tất.
        clearInMemoryResetToken();
        setNewPassword('');
        setConfirmPassword('');
        setStatus('success');
        setBannerMessage(data.message);
        return;
      }

      const errorBody = (await response.json().catch(() => ({}))) as ApiErrorPayload;
      const serverCode = errorBody.error?.code ?? null;
      const serverMessage =
        errorBody.error?.message ?? 'Không thể đặt lại mật khẩu. Vui lòng thử lại.';

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

      const nextErrors: FieldErrors = {};
      for (const detail of errorBody.error?.details ?? []) {
        if (detail.field === 'newPassword' && !nextErrors.newPassword) {
          nextErrors.newPassword = detail.message;
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

  if (!tokenInitialized) {
    return (
      <Card className="w-full shadow-md">
        <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-center">
          <Loader2 className="size-6 animate-spin text-primary" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">Đang tải...</p>
        </CardContent>
      </Card>
    );
  }

  if (status === 'success') {
    return (
      <Card className="w-full shadow-md">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex size-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
            <CheckCircle2 className="size-6" aria-hidden="true" />
          </div>
          <CardTitle>Đặt lại mật khẩu thành công</CardTitle>
          <CardDescription>
            Mật khẩu mới đã được áp dụng và tất cả các thiết bị cũ đã được đăng xuất.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <Alert variant="success" aria-live="polite">
            <CheckCircle2 aria-hidden="true" />
            <div>
              <AlertTitle>Mật khẩu mới đã có hiệu lực</AlertTitle>
              <AlertDescription>{bannerMessage}</AlertDescription>
            </div>
          </Alert>

          <Button asChild size="lg" className="w-full">
            <Link href="/login" rel="noreferrer">
              Đăng nhập bằng mật khẩu mới
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!resetToken) {
    return (
      <Card className="w-full shadow-md">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex size-12 items-center justify-center rounded-full bg-amber-100 text-amber-700">
            <ShieldAlert className="size-6" aria-hidden="true" />
          </div>
          <CardTitle>Liên kết đặt lại mật khẩu không hợp lệ</CardTitle>
          <CardDescription>
            Liên kết không còn hiệu lực hoặc trang vừa được tải lại. Vui lòng mở lại liên kết trong
            hộp thư hoặc yêu cầu liên kết mới.
          </CardDescription>
        </CardHeader>

        <CardContent className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Button asChild className="w-full px-3">
            <Link href="/forgot-password" rel="noreferrer">
              Yêu cầu liên kết mới
            </Link>
          </Button>
          <Button asChild variant="outline" className="w-full px-3">
            <Link href="/login" rel="noreferrer">
              Quay lại Đăng nhập
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const isSubmitting = status === 'loading';
  const isBlocked = isSubmitting || retryAfterSeconds > 0;
  const isTokenError = errorCode === 'TOKEN_INVALID' || errorCode === 'TOKEN_EXPIRED';

  return (
    <Card className="w-full shadow-md">
      <CardHeader className="space-y-1 text-center">
        <CardTitle>Tạo mật khẩu mới</CardTitle>
        <CardDescription>
          Nhập mật khẩu mới dài 12–128 ký tự (không dấu tiếng Việt). Sau khi hoàn tất, các thiết bị
          đang đăng nhập trước đó sẽ tự động được đăng xuất.
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
                  {errorCode === 'TOKEN_EXPIRED'
                    ? 'Liên kết đã hết hạn'
                    : errorCode === 'TOKEN_INVALID'
                      ? 'Liên kết không hợp lệ'
                      : 'Đặt lại mật khẩu chưa thành công'}
                </AlertTitle>
                <AlertDescription>
                  {bannerMessage}
                  {isTokenError ? (
                    <span className="mt-1.5 block">
                      <Link
                        href="/forgot-password"
                        rel="noreferrer"
                        className="font-medium underline"
                      >
                        Yêu cầu liên kết đặt lại mật khẩu mới
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
            <Label htmlFor="reset-new-password">Mật khẩu mới</Label>
            <PasswordInput
              id="reset-new-password"
              name="newPassword"
              autoComplete="new-password"
              placeholder="Tối thiểu 12 ký tự, không dấu tiếng Việt"
              value={newPassword}
              onChange={(event) => {
                setNewPassword(event.target.value);
                clearFieldError('newPassword');
              }}
              disabled={isSubmitting}
              aria-invalid={Boolean(fieldErrors.newPassword)}
              aria-describedby={
                fieldErrors.newPassword ? 'reset-new-password-error' : 'reset-new-password-hint'
              }
              required
            />
            <p id="reset-new-password-hint" className="text-xs text-muted-foreground">
              Độ dài từ 12 đến 128 ký tự, cho phép khoảng trắng, không dấu tiếng Việt và không trùng
              email/họ tên/ID tài khoản.
            </p>
            {fieldErrors.newPassword ? (
              <p id="reset-new-password-error" role="alert" className="text-xs text-destructive">
                {fieldErrors.newPassword}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="reset-confirm-password">Xác nhận mật khẩu mới</Label>
            <PasswordInput
              id="reset-confirm-password"
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
                fieldErrors.confirmPassword ? 'reset-confirm-password-error' : undefined
              }
              required
            />
            {fieldErrors.confirmPassword ? (
              <p
                id="reset-confirm-password-error"
                role="alert"
                className="text-xs text-destructive"
              >
                {fieldErrors.confirmPassword}
              </p>
            ) : null}
          </div>

          <Button type="submit" size="lg" className="w-full" disabled={isBlocked}>
            {isSubmitting ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Đang cập nhật mật khẩu...
              </>
            ) : retryAfterSeconds > 0 ? (
              `Thử lại sau ${retryAfterSeconds}s`
            ) : (
              <>
                <KeyRound className="size-4" aria-hidden="true" />
                Đặt lại mật khẩu
              </>
            )}
          </Button>
        </form>
      </CardContent>

      <CardFooter className="flex justify-center border-t pt-4 text-sm text-muted-foreground">
        <Link href="/login" rel="noreferrer" className="font-medium text-primary hover:underline">
          Quay lại trang Đăng nhập
        </Link>
      </CardFooter>
    </Card>
  );
}
