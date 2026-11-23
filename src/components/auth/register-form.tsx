'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertCircle, CheckCircle2, Clock, Loader2 } from 'lucide-react';

import { PasswordInput } from '@/components/auth/password-input';
import { savePendingVerificationHint } from '@/components/auth/pending-verification-storage';
import { TurnstileWidget } from '@/components/auth/turnstile-widget';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { UserGender } from '@/core/db/schema/enums';
import { cn } from '@/lib/utils';
import { registerInputSchema } from '@/modules/auth/auth.schemas';

interface ApiErrorPayload {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly details?: readonly { readonly field?: string; readonly message: string }[];
  };
}

interface RegisterSuccessPayload {
  readonly message: string;
  readonly verificationRequired: boolean;
}

type FormStatus = 'idle' | 'loading' | 'success' | 'error' | 'rate_limited';
type FieldErrors = Partial<
  Record<
    | 'fullName'
    | 'username'
    | 'gender'
    | 'email'
    | 'dateOfBirth'
    | 'password'
    | 'acceptedTerms'
    | 'captchaToken',
    string
  >
>;

const GENDER_OPTIONS: ReadonlyArray<{ readonly value: UserGender; readonly label: string }> = [
  { value: 'male', label: 'Nam' },
  { value: 'female', label: 'Nữ' },
  { value: 'other', label: 'Khác' },
];

export interface RegisterFormProps {
  readonly turnstileSiteKey: string;
  readonly cspNonce?: string;
}

export function RegisterForm({ turnstileSiteKey, cspNonce }: RegisterFormProps) {
  const router = useRouter();

  const [fullName, setFullName] = React.useState('');
  const [username, setUsername] = React.useState('');
  const [gender, setGender] = React.useState<UserGender | ''>('');
  const [email, setEmail] = React.useState('');
  const [dateOfBirth, setDateOfBirth] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [acceptedTerms, setAcceptedTerms] = React.useState(false);
  const [captchaToken, setCaptchaToken] = React.useState('');
  const [turnstileResetSignal, setTurnstileResetSignal] = React.useState(0);

  const [status, setStatus] = React.useState<FormStatus>('idle');
  const [errorCode, setErrorCode] = React.useState<string | null>(null);
  const [bannerMessage, setBannerMessage] = React.useState('');
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
    if (status === 'loading' || retryAfterSeconds > 0) {
      return;
    }

    setFieldErrors({});
    setBannerMessage('');
    setErrorCode(null);

    // Kiểm tra nhanh phía client bằng cùng Zod schema để phản hồi tức thì;
    // máy chủ luôn xác thực độc lập hoàn toàn.
    const clientParsed = registerInputSchema.safeParse({
      fullName,
      username,
      gender: gender || undefined,
      email,
      dateOfBirth,
      password,
      acceptedTerms,
      captchaToken,
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
      setBannerMessage('Vui lòng kiểm tra lại các thông tin được đánh dấu bên dưới.');
      return;
    }

    setStatus('loading');

    try {
      const response = await fetch('/api/v1/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fullName,
          username,
          gender,
          email,
          dateOfBirth,
          password,
          acceptedTerms,
          captchaToken,
        }),
      });

      if (response.ok) {
        const data = (await response.json()) as RegisterSuccessPayload;
        const now = Date.now();
        setStatus('success');
        setBannerMessage(data.message);
        savePendingVerificationHint({
          email: clientParsed.data.email,
          savedAt: now,
          sentAt: now,
          notice: data.message,
        });
        router.push('/verify-email');
        return;
      }

      const errorBody = (await response.json().catch(() => ({}))) as ApiErrorPayload;
      const serverCode = errorBody.error?.code;
      const serverMessage =
        errorBody.error?.message ?? 'Không thể hoàn tất đăng ký. Vui lòng thử lại.';

      if (response.status === 429 || serverCode === 'RATE_LIMITED') {
        const retryHeader = Number(response.headers.get('Retry-After') ?? '60');
        const waitSeconds =
          Number.isFinite(retryHeader) && retryHeader > 0 ? Math.ceil(retryHeader) : 60;
        setRetryAfterSeconds(waitSeconds);
        setStatus('rate_limited');
        setBannerMessage(serverMessage);
        setTurnstileResetSignal((prev) => prev + 1);
        return;
      }

      const nextErrors: FieldErrors = {};
      for (const detail of errorBody.error?.details ?? []) {
        const key = detail.field as keyof FieldErrors | undefined;
        if (key && !nextErrors[key]) {
          nextErrors[key] = detail.message;
        }
      }
      if (serverCode === 'CAPTCHA_INVALID' || serverCode === 'CAPTCHA_REQUIRED') {
        nextErrors.captchaToken = serverMessage;
      }

      setFieldErrors(nextErrors);
      setErrorCode(serverCode ?? null);
      setStatus('error');
      setBannerMessage(serverMessage);
      // Token Turnstile chỉ sử dụng 1 lần: reset để người dùng lấy token mới.
      setTurnstileResetSignal((prev) => prev + 1);
    } catch {
      setStatus('error');
      setBannerMessage('Không thể kết nối đến máy chủ. Vui lòng kiểm tra mạng và thử lại.');
      setTurnstileResetSignal((prev) => prev + 1);
    }
  }

  const isSubmitting = status === 'loading';
  const isBlocked = isSubmitting || retryAfterSeconds > 0 || status === 'success';
  const isEmailConflict = errorCode === 'CONFLICT' && Boolean(fieldErrors.email);
  const isUsernameConflict = errorCode === 'CONFLICT' && Boolean(fieldErrors.username);

  return (
    <Card className="w-full shadow-md">
      <CardHeader className="space-y-1 text-center">
        <CardTitle>Tạo tài khoản Tomato</CardTitle>
      </CardHeader>

      <CardContent>
        <div aria-live="polite" className="mb-4 space-y-3">
          {status === 'success' ? (
            <Alert variant="success">
              <CheckCircle2 aria-hidden="true" />
              <div>
                <AlertTitle>Đăng ký thành công</AlertTitle>
                <AlertDescription>{bannerMessage}</AlertDescription>
              </div>
            </Alert>
          ) : null}

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
            <Alert variant={isEmailConflict ? 'warning' : 'destructive'}>
              <AlertCircle aria-hidden="true" />
              <div className="space-y-2">
                <AlertTitle>
                  {isEmailConflict
                    ? 'Email đã được đăng ký'
                    : isUsernameConflict
                      ? 'ID tài khoản đã được sử dụng'
                      : 'Không thể đăng ký'}
                </AlertTitle>
                <AlertDescription>{bannerMessage}</AlertDescription>
                {isEmailConflict ? (
                  <Button asChild size="sm" variant="outline" className="bg-background">
                    <Link href="/login">Đi tới trang Đăng nhập</Link>
                  </Button>
                ) : null}
              </div>
            </Alert>
          ) : null}
        </div>

        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="fullName">Họ tên</Label>
            <Input
              id="fullName"
              name="fullName"
              type="text"
              autoComplete="name"
              placeholder="Họ tên"
              value={fullName}
              onChange={(event) => {
                setFullName(event.target.value);
                clearFieldError('fullName');
              }}
              disabled={isSubmitting}
              aria-invalid={Boolean(fieldErrors.fullName)}
              aria-describedby={fieldErrors.fullName ? 'fullName-error' : undefined}
              required
            />
            {fieldErrors.fullName ? (
              <p id="fullName-error" role="alert" className="text-xs text-destructive">
                {fieldErrors.fullName}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="username">ID Tài khoản</Label>
            <div className="relative">
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm font-medium text-muted-foreground"
              >
                @
              </span>
              <Input
                id="username"
                name="username"
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="id_tai_khoan"
                value={username}
                onChange={(event) => {
                  setUsername(event.target.value);
                  clearFieldError('username');
                }}
                disabled={isSubmitting}
                aria-invalid={Boolean(fieldErrors.username)}
                aria-describedby={fieldErrors.username ? 'username-error' : undefined}
                className="pl-7"
                required
              />
            </div>
            {fieldErrors.username ? (
              <p id="username-error" role="alert" className="text-xs text-destructive">
                {fieldErrors.username}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="email">Địa chỉ email</Label>
            <Input
              id="email"
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
              aria-describedby={fieldErrors.email ? 'email-error' : undefined}
              required
            />
            {fieldErrors.email ? (
              <p id="email-error" role="alert" className="text-xs text-destructive">
                {fieldErrors.email}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="dateOfBirth">Ngày sinh</Label>
            <Input
              id="dateOfBirth"
              name="dateOfBirth"
              type="date"
              autoComplete="bday"
              value={dateOfBirth}
              onChange={(event) => {
                setDateOfBirth(event.target.value);
                clearFieldError('dateOfBirth');
              }}
              disabled={isSubmitting}
              aria-invalid={Boolean(fieldErrors.dateOfBirth)}
              aria-describedby={fieldErrors.dateOfBirth ? 'dateOfBirth-error' : 'dateOfBirth-hint'}
              required
            />
            {fieldErrors.dateOfBirth ? (
              <p id="dateOfBirth-error" role="alert" className="text-xs text-destructive">
                {fieldErrors.dateOfBirth}
              </p>
            ) : (
              <p id="dateOfBirth-hint" className="text-xs text-muted-foreground">
                Bạn phải đủ từ 13 tuổi trở lên để sử dụng Tomato.
              </p>
            )}
          </div>

          <fieldset
            className="space-y-1.5"
            aria-describedby={fieldErrors.gender ? 'gender-error' : undefined}
          >
            <legend className="text-sm font-medium leading-none">Giới tính</legend>
            <div className="grid grid-cols-3 gap-2">
              {GENDER_OPTIONS.map((option) => {
                const selected = gender === option.value;
                return (
                  <label
                    key={option.value}
                    className={cn(
                      'flex h-10 cursor-pointer items-center justify-between rounded-md border px-3 text-sm transition-colors',
                      selected
                        ? 'border-primary bg-primary/5 font-medium text-foreground'
                        : 'border-input bg-background text-foreground hover:bg-accent/50',
                      fieldErrors.gender ? 'border-destructive' : null,
                      isSubmitting ? 'pointer-events-none opacity-50' : null,
                    )}
                  >
                    <span>{option.label}</span>
                    <input
                      type="radio"
                      name="gender"
                      value={option.value}
                      checked={selected}
                      onChange={() => {
                        setGender(option.value);
                        clearFieldError('gender');
                      }}
                      disabled={isSubmitting}
                      className="size-4 accent-primary"
                    />
                  </label>
                );
              })}
            </div>
            {fieldErrors.gender ? (
              <p id="gender-error" role="alert" className="text-xs text-destructive">
                {fieldErrors.gender}
              </p>
            ) : null}
          </fieldset>

          <div className="space-y-1.5">
            <Label htmlFor="password">Mật khẩu</Label>
            <PasswordInput
              id="password"
              name="password"
              autoComplete="new-password"
              placeholder="Mật khẩu"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                clearFieldError('password');
              }}
              disabled={isSubmitting}
              aria-invalid={Boolean(fieldErrors.password)}
              aria-describedby={fieldErrors.password ? 'password-error' : undefined}
              required
            />
            {fieldErrors.password ? (
              <p id="password-error" role="alert" className="text-xs text-destructive">
                {fieldErrors.password}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-start gap-2.5">
              <Checkbox
                id="acceptedTerms"
                checked={acceptedTerms}
                onCheckedChange={(checked) => {
                  setAcceptedTerms(checked === true);
                  clearFieldError('acceptedTerms');
                }}
                disabled={isSubmitting}
                aria-invalid={Boolean(fieldErrors.acceptedTerms)}
                aria-describedby={fieldErrors.acceptedTerms ? 'acceptedTerms-error' : undefined}
                className="mt-0.5"
              />
              <Label
                htmlFor="acceptedTerms"
                className="block cursor-pointer text-sm leading-snug font-normal text-muted-foreground"
              >
                Tôi đồng ý với{' '}
                <span className="font-medium text-foreground">Điều khoản sử dụng</span> và{' '}
                <span className="font-medium text-foreground">Chính sách quyền riêng tư</span> của
                Tomato.
              </Label>
            </div>
            {fieldErrors.acceptedTerms ? (
              <p id="acceptedTerms-error" role="alert" className="text-xs text-destructive">
                {fieldErrors.acceptedTerms}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <TurnstileWidget
              siteKey={turnstileSiteKey}
              nonce={cspNonce}
              resetSignal={turnstileResetSignal}
              onTokenChange={(token) => {
                setCaptchaToken(token);
                if (token) {
                  clearFieldError('captchaToken');
                }
              }}
            />
            {fieldErrors.captchaToken ? (
              <p id="captchaToken-error" role="alert" className="text-xs text-destructive">
                {fieldErrors.captchaToken}
              </p>
            ) : null}
          </div>

          <Button type="submit" size="lg" className="w-full" disabled={isBlocked}>
            {isSubmitting ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Đang tạo tài khoản...
              </>
            ) : retryAfterSeconds > 0 ? (
              `Thử lại sau ${retryAfterSeconds}s`
            ) : (
              'Đăng ký tài khoản'
            )}
          </Button>
        </form>
      </CardContent>

      <CardFooter className="flex flex-col gap-2 border-t pt-4 text-center text-sm text-muted-foreground">
        <p>
          Đã có tài khoản Tomato?{' '}
          <Link href="/login" className="font-medium text-primary hover:underline">
            Đăng nhập ngay
          </Link>
        </p>
      </CardFooter>
    </Card>
  );
}
