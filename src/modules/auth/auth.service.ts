import 'server-only';

import { randomInt } from 'node:crypto';

import { getCaptchaProvider, type CaptchaProvider } from '@/core/captcha';
import { getEnv } from '@/core/config/env';
import { generatePublicId, generateUuidV7 } from '@/core/crypto/id';
import { generateOtpCode, hashOtpCode, verifyOtpCode } from '@/core/crypto/otp';
import {
  EnvPepperSecretProvider,
  hashPassword,
  verifyDummyPassword,
  verifyPassword,
  type PepperSecretProvider,
} from '@/core/crypto/password';
import {
  generateSecureToken,
  hashScopedTokenSha256,
  hashTokenSha256,
  timingSafeEqualHex,
} from '@/core/crypto/token';
import { isPostgresUniqueViolation } from '@/core/db';
import type { UserGender, UserRow, UserStatus } from '@/core/db/schema';
import {
  EmailDeliveryError,
  buildAccountLockedAlertEmail,
  buildPasswordChangeOtpEmail,
  buildPasswordChangedAlertEmail,
  buildPasswordResetAlertEmail,
  buildPasswordResetLinkEmail,
  buildVerificationOtpEmail,
  getEmailProvider,
  type EmailProvider,
} from '@/core/email';
import { logger } from '@/core/logger';
import {
  AUTH_RATE_LIMITS,
  getLoginBruteForceGuard,
  getRateLimiter,
  type LoginBruteForceStore,
  type RateLimiter,
} from '@/core/redis';
import { getAuditLogService, type AuditLogService } from '@/core/security/audit-log.service';
import type { RequestClientContext } from '@/core/security/client-context';
import { formatZodErrorDetails } from '@/core/security/http-response';
import { AuthDomainError } from '@/modules/auth/auth.errors';
import { AUTH_MESSAGES } from '@/modules/auth/auth.messages';
import {
  assertCanChangeOwnPassword,
  type AuthenticatedPrincipal,
} from '@/modules/auth/auth.policy';
import { AuthRepository, type IdentityWithUser } from '@/modules/auth/auth.repository';
import {
  changePasswordInputSchema,
  createRegisterInputSchema,
  forgotPasswordInputSchema,
  getWeakPasswordContextViolation,
  loginInputSchema,
  resendVerificationInputSchema,
  resetPasswordInputSchema,
  verifyEmailInputSchema,
  verifyPasswordChangeOtpInputSchema,
} from '@/modules/auth/auth.schemas';
import { parseDeviceInfo } from '@/modules/auth/device-info';
import {
  SessionService,
  isSessionCurrentlyActive,
  toPublicUserProfile,
  type CreatedSessionResult,
  type IssuedSessionTokens,
  type PublicUserProfile,
} from '@/modules/auth/session.service';

export const EMAIL_VERIFY_OTP_TTL_MINUTES = 15;
export const EMAIL_VERIFY_OTP_TTL_MS = EMAIL_VERIFY_OTP_TTL_MINUTES * 60 * 1000;
export const EMAIL_VERIFY_OTP_MAX_ATTEMPTS = 5;
export const RESEND_COOLDOWN_SECONDS = AUTH_RATE_LIMITS.resendVerificationCooldown.windowSeconds;
export const PASSWORD_RESET_TOKEN_TTL_MINUTES = 15;
export const PASSWORD_RESET_TOKEN_TTL_MS = PASSWORD_RESET_TOKEN_TTL_MINUTES * 60 * 1000;
export const PASSWORD_CHANGE_OTP_TTL_MINUTES = 10;
export const PASSWORD_CHANGE_OTP_TTL_MS = PASSWORD_CHANGE_OTP_TTL_MINUTES * 60 * 1000;
export const PASSWORD_CHANGE_OTP_MAX_ATTEMPTS = 5;
export const PASSWORD_CHANGE_TICKET_TTL_MINUTES = 10;
export const PASSWORD_CHANGE_TICKET_TTL_MS = PASSWORD_CHANGE_TICKET_TTL_MINUTES * 60 * 1000;
export const PASSWORD_CHANGE_TICKET_MAX_ATTEMPTS = 5;
export const CHANGE_PASSWORD_OTP_COOLDOWN_SECONDS =
  AUTH_RATE_LIMITS.changePasswordOtpCooldown.windowSeconds;
// Ngưỡng tổng số lần đăng nhập sai liên tiếp trên 1 tài khoản (cộng dồn mọi IP) kích hoạt tự khóa `locked` (Mục 4.2).
export const ACCOUNT_LOCK_FAILED_ATTEMPTS_THRESHOLD = 50;
// Sau 24 giờ không xác minh, tài khoản pending_verification được phép đăng ký đè theo Mục 4.1.
export const PENDING_VERIFICATION_EXPIRY_MS = 24 * 60 * 60 * 1000;
// Sàn thời gian tối thiểu + jitter cho `/resend-verification` và `/verify-email` nhằm triệt tiêu timing oracle
// giữa email không tồn tại (~5ms) và email đang `pending_verification` (gửi SMTP / mở DB transaction).
export const DEFAULT_MIN_RESEND_RESPONSE_MS = 250;
// Sàn thời gian tối thiểu + jitter cho các nhánh 401 INVALID_CREDENTIALS của `/login`
// nhằm che khuất chênh lệch giữa 1 câu INSERT (email không tồn tại) và 1 DB transaction (sai mật khẩu).
export const DEFAULT_MIN_LOGIN_FAILURE_RESPONSE_MS = 350;
const RESEND_TIMING_JITTER_MS = 75;

export interface RegisterResult {
  readonly message: string;
  readonly verificationRequired: true;
}

export interface VerifyEmailResult {
  readonly verified: true;
  readonly message: string;
}

export interface ResendVerificationResult {
  readonly message: string;
  readonly cooldownSeconds: number;
}

export interface LoginResult {
  readonly user: PublicUserProfile;
  readonly message: string;
  readonly tokens: IssuedSessionTokens;
}

export interface ForgotPasswordResult {
  readonly message: string;
  readonly expiresInMinutes: number;
}

export interface ResetPasswordResult {
  readonly reset: true;
  readonly message: string;
}

export interface RequestPasswordChangeOtpResult {
  readonly message: string;
  readonly cooldownSeconds: number;
  readonly expiresInMinutes: number;
}

export interface VerifyPasswordChangeOtpResult {
  readonly verified: true;
  readonly expiresInMinutes: number;
  readonly message: string;
  /** Ticket opaque 256-bit trả về tầng Route Handler để gắn `HttpOnly` cookie (KHÔNG trả ra JSON body web). */
  readonly ticket: string;
}

export interface ChangePasswordResult {
  readonly changed: true;
  readonly revokedOtherSessionsCount: number;
  readonly message: string;
  readonly tokens: IssuedSessionTokens;
}

export interface AuthServiceDependencies {
  readonly repository?: AuthRepository;
  readonly sessionService?: SessionService;
  readonly rateLimiter?: RateLimiter;
  readonly loginProtection?: LoginBruteForceStore;
  readonly emailProvider?: EmailProvider;
  readonly captchaProvider?: CaptchaProvider;
  readonly auditLogService?: AuditLogService;
  readonly pepperProvider?: PepperSecretProvider;
  readonly appUrl?: string;
  readonly now?: () => Date;
  /** Sàn thời gian tối thiểu (ms) cho `/resend-verification` & `/verify-email` (mặc định 250ms ở prod/dev, 0ms ở test). */
  readonly minResendResponseMs?: number;
  /** Sàn thời gian tối thiểu (ms) cho nhánh 401 của `/login` (mặc định 350ms ở prod/dev, 0ms ở test). */
  readonly minLoginFailureResponseMs?: number;
}

type VerifyOtpTransactionOutcome =
  | { readonly kind: 'verified' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'max_attempts' }
  | { readonly kind: 'wrong_code'; readonly remainingAttempts: number };

type LoginTransactionOutcome =
  | { readonly kind: 'created'; readonly created: CreatedSessionResult; readonly user: UserRow }
  | { readonly kind: 'status_changed'; readonly status: UserStatus };

type ForgotPasswordTransactionOutcome =
  | { readonly kind: 'issued'; readonly user: UserRow }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_verified' }
  | { readonly kind: 'suspended' };

type ResetPasswordTransactionOutcome =
  | {
      readonly kind: 'reset';
      readonly user: UserRow;
      readonly email: string;
      readonly unlockedFromLocked: boolean;
      readonly revokedSessionsCount: number;
    }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'password_violation'; readonly message: string };

type RequestPasswordChangeOtpTransactionOutcome =
  | { readonly kind: 'issued'; readonly user: UserRow; readonly email: string }
  | { readonly kind: 'unauthorized' };

type VerifyPasswordChangeOtpTransactionOutcome =
  | { readonly kind: 'issued'; readonly rawTicket: string }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'otp_invalid' }
  | { readonly kind: 'otp_expired' }
  | { readonly kind: 'otp_max_attempts' }
  | { readonly kind: 'otp_wrong'; readonly remainingAttempts: number };

type ChangePasswordTransactionOutcome =
  | {
      readonly kind: 'changed';
      readonly user: UserRow;
      readonly email: string;
      readonly created: CreatedSessionResult;
      readonly revokedOtherSessionsCount: number;
    }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'ticket_invalid' }
  | { readonly kind: 'ticket_expired' }
  | { readonly kind: 'ticket_max_attempts' };

/**
 * Tầng nghiệp vụ Auth cốt lõi (tách biệt hoàn toàn khỏi Next.js HTTP/cookies).
 */
export class AuthService {
  private readonly repository: AuthRepository;
  private readonly sessionService: SessionService;
  private readonly rateLimiter: RateLimiter;
  private readonly loginProtection: LoginBruteForceStore;
  private readonly emailProvider: EmailProvider;
  private readonly captchaProvider: CaptchaProvider;
  private readonly auditLogService: AuditLogService;
  private readonly pepperProvider: PepperSecretProvider;
  private readonly appUrlOverride?: string;
  private readonly now: () => Date;
  private readonly minResendResponseMs: number;
  private readonly minLoginFailureResponseMs: number;

  constructor(deps: AuthServiceDependencies = {}) {
    this.repository = deps.repository ?? new AuthRepository();
    this.rateLimiter = deps.rateLimiter ?? getRateLimiter();
    this.loginProtection = deps.loginProtection ?? getLoginBruteForceGuard();
    this.emailProvider = deps.emailProvider ?? getEmailProvider();
    this.captchaProvider = deps.captchaProvider ?? getCaptchaProvider();
    this.auditLogService = deps.auditLogService ?? getAuditLogService();
    this.pepperProvider = deps.pepperProvider ?? new EnvPepperSecretProvider();
    this.appUrlOverride = deps.appUrl;
    this.now = deps.now ?? (() => new Date());
    this.minResendResponseMs =
      deps.minResendResponseMs ??
      (process.env.NODE_ENV === 'test' ? 0 : DEFAULT_MIN_RESEND_RESPONSE_MS);
    this.minLoginFailureResponseMs =
      deps.minLoginFailureResponseMs ??
      (process.env.NODE_ENV === 'test' ? 0 : DEFAULT_MIN_LOGIN_FAILURE_RESPONSE_MS);
    this.sessionService =
      deps.sessionService ??
      new SessionService({
        repository: this.repository,
        rateLimiter: this.rateLimiter,
        auditLogService: this.auditLogService,
        now: this.now,
      });
  }

  /**
   * Đăng ký tài khoản mới + phát hành OTP xác minh email (Mục 4.1).
   * - Luôn kiểm tra Rate Limit theo IP TRƯỚC khi validate nặng, gọi Turnstile, băm Argon2id hay truy vấn DB.
   * - Nếu email đã tồn tại (active/locked/suspended/deleted): trả lỗi rõ `409 CONFLICT` để điều hướng sang Đăng nhập.
   * - Nếu email đang `pending_verification`: bảo vệ chống tráo mật khẩu trong hạn 24h và cấp lại OTP mới.
   * - Chống race condition đăng ký đồng thời bằng cách bắt mã lỗi PostgreSQL `23505`.
   */
  async register(rawInput: unknown, context: RequestClientContext): Promise<RegisterResult> {
    // 1. Rate limit theo IP chạy đầu tiên (Mục 6.4: 5 lần / 15 phút theo IP).
    const ipLimit = await this.rateLimiter.consume(
      `register:ip:${context.rateLimitIpKey}`,
      AUTH_RATE_LIMITS.registerByIp,
    );
    if (!ipLimit.allowed) {
      throw new AuthDomainError({
        status: 429,
        code: 'RATE_LIMITED',
        message: AUTH_MESSAGES.rateLimited(ipLimit.retryAfterSeconds),
        retryAfterSeconds: ipLimit.retryAfterSeconds,
      });
    }

    // 2. Kiểm tra dữ liệu đầu vào nghiêm ngặt bằng Zod.
    const parsed = createRegisterInputSchema(this.now).safeParse(rawInput);
    if (!parsed.success) {
      throw new AuthDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: AUTH_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }
    const input = parsed.data;

    // 3. Xác thực Cloudflare Turnstile phía máy chủ trước khi tiêu tốn CPU cho Argon2id hoặc ghi DB.
    const captchaResult = await this.captchaProvider.verify({
      token: input.captchaToken,
      remoteIp: context.ipAddress,
    });
    if (!captchaResult.success) {
      throw new AuthDomainError({
        status: 400,
        code: 'CAPTCHA_INVALID',
        message: AUTH_MESSAGES.captchaInvalid,
      });
    }

    const currentTime = this.now();
    const existing = await this.repository.findEmailIdentityWithUser(input.email);

    if (existing) {
      await this.handleExistingAccountRegistration(existing, input, context, currentTime);
      return {
        message: AUTH_MESSAGES.registerAccepted,
        verificationRequired: true,
      };
    }

    const existingUsername = await this.repository.findUserByUsername(input.username);
    if (existingUsername) {
      // Chống TOCTOU race condition khi 2 request đăng ký cùng (email, username) chạy song song:
      // nếu request A vừa commit ngay trong khoảng giữa `findEmailIdentityWithUser` và `findUserByUsername`
      // của request B, kiểm tra lại theo email để xử lý đúng theo luồng đăng ký trùng đồng thời (trả 202 cho pending).
      const concurrentByEmail = await this.repository.findEmailIdentityWithUser(input.email);
      if (concurrentByEmail) {
        await this.handleConcurrentDuplicateRegistration(input.email, context, concurrentByEmail);
        return {
          message: AUTH_MESSAGES.registerAccepted,
          verificationRequired: true,
        };
      }

      throw new AuthDomainError({
        status: 409,
        code: 'CONFLICT',
        message: AUTH_MESSAGES.usernameAlreadyExists,
        details: [{ field: 'username', message: AUTH_MESSAGES.usernameAlreadyExists }],
      });
    }

    if (
      typeof this.repository.isHandleReservedByOtherUser === 'function' &&
      (await this.repository.isHandleReservedByOtherUser(input.username, null, currentTime))
    ) {
      throw new AuthDomainError({
        status: 409,
        code: 'CONFLICT',
        message: AUTH_MESSAGES.usernameAlreadyExists,
        details: [{ field: 'username', message: AUTH_MESSAGES.usernameAlreadyExists }],
      });
    }

    // 4. Băm mật khẩu bằng Argon2id + Pepper ngoài transaction DB để không giữ kết nối PG trong lúc tính toán CPU.
    const { hash: passwordHash, pepperVersion } = await hashPassword(
      input.password,
      this.pepperProvider,
    );
    const userId = generateUuidV7();
    const publicId = generatePublicId();
    const identityId = generateUuidV7();
    const otpCode = generateOtpCode();
    const otpTokenHash = hashOtpCode(otpCode, { userId, purpose: 'email_verify' });
    const otpExpiresAt = new Date(currentTime.getTime() + EMAIL_VERIFY_OTP_TTL_MS);

    try {
      await this.repository.getDb().transaction(async (tx) => {
        await this.repository.createPendingUserWithIdentityAndOtp(
          {
            userId,
            publicId,
            identityId,
            emailNormalized: input.email,
            username: input.username,
            fullName: input.fullName,
            gender: input.gender,
            dateOfBirth: input.dateOfBirth,
            passwordHash,
            pepperVersion,
            otpTokenHash,
            otpExpiresAt,
            now: currentTime,
          },
          tx,
        );

        await this.auditLogService.record(
          {
            userId,
            action: 'REGISTER',
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            metadata: {
              provider: 'email_password',
              outcome: 'created',
            },
          },
          tx,
        );
      });
    } catch (error) {
      // Bắt race condition khi 2 request đăng ký đồng thời (PostgreSQL 23505):
      // phân biệt trùng username với email khác (409 username) vs double-submit cùng email.
      if (isPostgresUniqueViolation(error)) {
        if (
          isPostgresUniqueViolation(error, 'users_username_unique') ||
          isPostgresUniqueViolation(error, 'idx_users_handle_norm')
        ) {
          const winnerByEmail = await this.repository.findEmailIdentityWithUser(input.email);
          if (!winnerByEmail || winnerByEmail.user.username !== input.username) {
            throw new AuthDomainError({
              status: 409,
              code: 'CONFLICT',
              message: AUTH_MESSAGES.usernameAlreadyExists,
              details: [{ field: 'username', message: AUTH_MESSAGES.usernameAlreadyExists }],
            });
          }
        }
        await this.handleConcurrentDuplicateRegistration(input.email, context);
        return {
          message: AUTH_MESSAGES.registerAccepted,
          verificationRequired: true,
        };
      }
      throw error;
    }

    // Ghi nhận cooldown 60s để tránh gửi lại OTP ngay lập tức sau khi vừa gửi OTP khởi tạo.
    await this.rateLimiter.consume(
      `resend:cooldown:${input.email}`,
      AUTH_RATE_LIMITS.resendVerificationCooldown,
    );

    await this.sendVerificationOtpEmail(input.email, input.fullName, otpCode);

    return {
      message: AUTH_MESSAGES.registerAccepted,
      verificationRequired: true,
    };
  }

  /**
   * Xác minh địa chỉ email bằng mã OTP 6 chữ số (Mục 4.1).
   * - Dùng `SELECT ... FOR UPDATE` trong transaction để đếm số lần thử sai nguyên tử.
   * - Quá 5 lần sai hủy OTP ngay lập tức (`consumed_at = NOW()`).
   * - Hợp lệ: chuyển trạng thái `active`, đánh dấu `verified_at` & `consumed_at`, ghi Audit Log `EMAIL_VERIFIED`.
   */
  async verifyEmail(rawInput: unknown, context: RequestClientContext): Promise<VerifyEmailResult> {
    const ipLimit = await this.rateLimiter.consume(
      `verify-email:ip:${context.rateLimitIpKey}`,
      AUTH_RATE_LIMITS.verifyEmailByIp,
    );
    if (!ipLimit.allowed) {
      throw new AuthDomainError({
        status: 429,
        code: 'RATE_LIMITED',
        message: AUTH_MESSAGES.rateLimited(ipLimit.retryAfterSeconds),
        retryAfterSeconds: ipLimit.retryAfterSeconds,
      });
    }

    const parsed = verifyEmailInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new AuthDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: AUTH_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }
    const input = parsed.data;

    // Rate limit bổ sung theo email chạy TRƯỚC truy vấn DB nhằm chặn tấn công đốt OTP phân tán từ nhiều IP.
    const emailLimit = await this.rateLimiter.consume(
      `verify-email:email:${input.email}`,
      AUTH_RATE_LIMITS.verifyEmailByEmail,
    );
    if (!emailLimit.allowed) {
      throw new AuthDomainError({
        status: 429,
        code: 'RATE_LIMITED',
        message: AUTH_MESSAGES.rateLimited(emailLimit.retryAfterSeconds),
        retryAfterSeconds: emailLimit.retryAfterSeconds,
      });
    }

    const startedAtMs = Date.now();
    const existing = await this.repository.findEmailIdentityWithUser(input.email);
    if (!existing || existing.user.status !== 'pending_verification') {
      await this.equalizeResponseDuration(startedAtMs, this.minResendResponseMs);
      throw new AuthDomainError({
        status: 400,
        code: 'TOKEN_INVALID',
        message: AUTH_MESSAGES.otpInvalidOrExpired,
      });
    }

    const currentTime = this.now();

    // Quan trọng: trả về kết quả phân nhánh thay vì throw bên trong transaction,
    // để việc tăng `attempt_count` hoặc đặt `consumed_at` khi nhập sai KHÔNG bị PostgreSQL ROLLBACK.
    // Luôn khóa `users FOR UPDATE` TRƯỚC khi khóa `verification_tokens` để đảm bảo thứ tự khóa
    // nhất quán (chống deadlock và chống race condition khi có resend OTP chạy song song).
    const outcome = await this.repository
      .getDb()
      .transaction<VerifyOtpTransactionOutcome>(async (tx) => {
        const lockedUser = await this.repository.lockUserById(existing.user.id, tx, 'update');
        if (!lockedUser || lockedUser.status !== 'pending_verification') {
          return { kind: 'invalid' };
        }

        const token = await this.repository.lockLatestUnconsumedEmailVerifyToken(
          existing.user.id,
          tx,
        );

        if (!token) {
          return { kind: 'invalid' };
        }

        if (token.expiresAt.getTime() <= currentTime.getTime()) {
          await this.repository.consumeVerificationToken(
            token.id,
            existing.user.id,
            currentTime,
            tx,
          );
          return { kind: 'expired' };
        }

        if (token.attemptCount >= EMAIL_VERIFY_OTP_MAX_ATTEMPTS) {
          await this.repository.consumeVerificationToken(
            token.id,
            existing.user.id,
            currentTime,
            tx,
          );
          return { kind: 'max_attempts' };
        }

        const matched = verifyOtpCode(input.otpCode, token.tokenHash, {
          userId: existing.user.id,
          purpose: 'email_verify',
        });

        if (!matched) {
          const nextAttempts = token.attemptCount + 1;
          const exhausted = nextAttempts >= EMAIL_VERIFY_OTP_MAX_ATTEMPTS;
          await this.repository.updateVerificationTokenAttempt(
            token.id,
            existing.user.id,
            nextAttempts,
            exhausted ? currentTime : null,
            tx,
          );

          if (exhausted) {
            return { kind: 'max_attempts' };
          }
          return {
            kind: 'wrong_code',
            remainingAttempts: EMAIL_VERIFY_OTP_MAX_ATTEMPTS - nextAttempts,
          };
        }

        const activated = await this.repository.activateUserAndConsumeEmailVerifyTokens(
          existing.user.id,
          existing.identity.id,
          currentTime,
          tx,
        );

        if (!activated) {
          return { kind: 'invalid' };
        }

        await this.auditLogService.record(
          {
            userId: existing.user.id,
            action: 'EMAIL_VERIFIED',
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            metadata: {
              provider: 'email_password',
            },
          },
          tx,
        );

        return { kind: 'verified' };
      });

    switch (outcome.kind) {
      case 'verified':
        return {
          verified: true,
          message: AUTH_MESSAGES.emailVerified,
        };
      case 'expired':
        await this.equalizeResponseDuration(startedAtMs, this.minResendResponseMs);
        throw new AuthDomainError({
          status: 400,
          code: 'TOKEN_EXPIRED',
          message: AUTH_MESSAGES.otpExpired,
        });
      case 'max_attempts':
        await this.equalizeResponseDuration(startedAtMs, this.minResendResponseMs);
        throw new AuthDomainError({
          status: 400,
          code: 'TOKEN_INVALID',
          message: AUTH_MESSAGES.otpRevokedMaxAttempts,
        });
      case 'wrong_code':
        await this.equalizeResponseDuration(startedAtMs, this.minResendResponseMs);
        throw new AuthDomainError({
          status: 400,
          code: 'TOKEN_INVALID',
          message: AUTH_MESSAGES.otpIncorrectWithRemaining(outcome.remainingAttempts),
        });
      case 'invalid':
        await this.equalizeResponseDuration(startedAtMs, this.minResendResponseMs);
        throw new AuthDomainError({
          status: 400,
          code: 'TOKEN_INVALID',
          message: AUTH_MESSAGES.otpInvalidOrExpired,
        });
    }
  }

  /**
   * Gửi lại mã OTP xác minh email (Mục 4.1 & Mục 6.4):
   * - Chạy đủ các tầng Rate Limit TRƯỚC truy vấn DB: 3 lần/15p theo IP, cooldown 60s theo email,
   *   3 lần/15p theo email và 5 lần/giờ theo email.
   * - Vô hiệu hóa toàn bộ OTP cũ trước khi phát hành OTP mới.
   */
  async resendVerification(
    rawInput: unknown,
    context: RequestClientContext,
  ): Promise<ResendVerificationResult> {
    const ipLimit = await this.rateLimiter.consume(
      `resend:ip:${context.rateLimitIpKey}`,
      AUTH_RATE_LIMITS.resendVerificationByIp,
    );
    if (!ipLimit.allowed) {
      throw new AuthDomainError({
        status: 429,
        code: 'RATE_LIMITED',
        message: AUTH_MESSAGES.rateLimited(ipLimit.retryAfterSeconds),
        retryAfterSeconds: ipLimit.retryAfterSeconds,
      });
    }

    const parsed = resendVerificationInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new AuthDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: AUTH_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }
    const { email } = parsed.data;

    // Kiểm tra cooldown 60s trước bộ đếm 15 phút / 1 giờ để click lặp không làm lãng phí hạn mức giờ.
    const cooldownLimit = await this.rateLimiter.consume(
      `resend:cooldown:${email}`,
      AUTH_RATE_LIMITS.resendVerificationCooldown,
    );
    if (!cooldownLimit.allowed) {
      throw new AuthDomainError({
        status: 429,
        code: 'RATE_LIMITED',
        message: AUTH_MESSAGES.resendCooldown(cooldownLimit.retryAfterSeconds),
        retryAfterSeconds: cooldownLimit.retryAfterSeconds,
      });
    }

    const emailBurstLimit = await this.rateLimiter.consume(
      `resend:email15m:${email}`,
      AUTH_RATE_LIMITS.resendVerificationByEmail,
    );
    if (!emailBurstLimit.allowed) {
      throw new AuthDomainError({
        status: 429,
        code: 'RATE_LIMITED',
        message: AUTH_MESSAGES.rateLimited(emailBurstLimit.retryAfterSeconds),
        retryAfterSeconds: emailBurstLimit.retryAfterSeconds,
      });
    }

    const emailHourlyLimit = await this.rateLimiter.consume(
      `resend:email1h:${email}`,
      AUTH_RATE_LIMITS.resendVerificationHourlyByEmail,
    );
    if (!emailHourlyLimit.allowed) {
      throw new AuthDomainError({
        status: 429,
        code: 'RATE_LIMITED',
        message: AUTH_MESSAGES.rateLimited(emailHourlyLimit.retryAfterSeconds),
        retryAfterSeconds: emailHourlyLimit.retryAfterSeconds,
      });
    }

    const startedAtMs = Date.now();
    const existing = await this.repository.findEmailIdentityWithUser(email);
    if (existing && existing.user.status === 'pending_verification') {
      const currentTime = this.now();
      const otpCode = generateOtpCode();
      const otpTokenHash = hashOtpCode(otpCode, {
        userId: existing.user.id,
        purpose: 'email_verify',
      });
      const otpExpiresAt = new Date(currentTime.getTime() + EMAIL_VERIFY_OTP_TTL_MS);

      // Khóa `users FOR UPDATE` trong transaction để đảm bảo tại mọi thời điểm chỉ có duy nhất
      // 1 OTP chưa tiêu thụ (chống race condition khi gửi lại đồng thời) và không cấp OTP cho user đã active.
      const reissued = await this.repository.getDb().transaction(async (tx) => {
        const lockedUser = await this.repository.lockUserById(existing.user.id, tx, 'update');
        if (!lockedUser || lockedUser.status !== 'pending_verification') {
          return false;
        }

        await this.repository.reissueEmailVerifyToken(
          {
            userId: existing.user.id,
            otpTokenHash,
            otpExpiresAt,
            now: currentTime,
          },
          tx,
        );
        return true;
      });

      if (reissued) {
        try {
          await this.sendVerificationOtpEmail(email, existing.user.fullName, otpCode);
        } catch (error) {
          // Lỗi SMTP đã được SmtpEmailAdapter ghi log an toàn (không chứa OTP).
          // Không ném 503 ra ngoài ở `/resend-verification` để tránh kẻ tấn công lợi dụng sự cố SMTP
          // làm kênh phân biệt email đang `pending_verification` với email không tồn tại.
          if (!(error instanceof AuthDomainError && error.status === 503)) {
            throw error;
          }
        }
      }
    }

    // Cân bằng sàn thời gian phản hồi + jitter CSPRNG chống timing oracle trên `/resend-verification`.
    await this.equalizeResponseDuration(startedAtMs, this.minResendResponseMs);

    return {
      message: AUTH_MESSAGES.resendAccepted,
      cooldownSeconds: RESEND_COOLDOWN_SECONDS,
    };
  }

  /**
   * Đăng nhập bằng Email + Mật khẩu và khởi tạo phiên thiết bị mới (Mục 4.2 & Mục 6.1–6.4):
   * 1. Chạy Rate Limit IP (`10 lần / 15 phút`) TRƯỚC khi validate nặng, truy DB hoặc băm Argon2id.
   * 2. Kiểm tra bộ đếm Brute-Force thông minh theo cặp `(email + IP)` trên Redis TRƯỚC DB/Argon2id:
   *    - Từ lần sai thứ 3: áp dụng Exponential Backoff (`1s -> 2s -> 4s -> 8s`, trả `429 Retry-After`).
   *    - Từ lần sai thứ 5: bắt buộc vượt qua Cloudflare Turnstile (`requireCaptcha: true`).
   *    - Cô lập theo `(email + IP)` để kẻ tấn công từ IP lạ không làm chậm chủ tài khoản từ IP/thiết bị quen.
   * 3. Nếu không tìm thấy identity -> vẫn chạy `verifyDummyPassword()` và tăng bộ đếm `(email + IP)`
   *    để hành vi & thời gian phản hồi đồng nhất tuyệt đối (chống User Enumeration).
   * 4. Mật khẩu sai trên tài khoản `active`: tăng nguyên tử `failed_login_attempts` trong DB;
   *    chạm mốc 50 lần sai liên tiếp -> chuyển `locked`, ghi `ACCOUNT_LOCKED` và gửi email cảnh báo
   *    (vẫn trả `401 INVALID_CREDENTIALS` cho mật khẩu sai để không lộ trạng thái khóa).
   * 5. Chỉ kiểm tra trạng thái tài khoản SAU khi xác minh đúng mật khẩu.
   * 6. Đăng nhập thành công: rehash nếu Pepper/Argon2 cũ, đặt `failed_login_attempts = 0`,
   *    cấp phiên mới và xóa bộ đếm sai `(email + IP)` trên Redis.
   */
  async login(rawInput: unknown, context: RequestClientContext): Promise<LoginResult> {
    // 1. Rate Limit theo IP chạy đầu tiên trước khi tiêu tốn CPU Argon2id hay truy DB.
    const ipLimit = await this.rateLimiter.consume(
      `login:ip:${context.rateLimitIpKey}`,
      AUTH_RATE_LIMITS.loginByIp,
    );
    if (!ipLimit.allowed) {
      throw new AuthDomainError({
        status: 429,
        code: 'RATE_LIMITED',
        message: AUTH_MESSAGES.rateLimited(ipLimit.retryAfterSeconds),
        retryAfterSeconds: ipLimit.retryAfterSeconds,
      });
    }

    // 2. Xác thực cấu trúc đầu vào bằng Zod.
    const parsed = loginInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new AuthDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: AUTH_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }
    const input = parsed.data;

    // 3. Chống Brute-Force thông minh theo cặp `(email + IP)` chạy TRƯỚC truy DB và Argon2id:
    //    chặn sớm trong thời gian Exponential Backoff (1s->2s->4s->8s) và ép Turnstile từ lần sai thứ 5.
    const pairState = await this.loginProtection.checkPair(input.email, context.rateLimitIpKey);
    if (pairState.backoffRemainingMs > 0) {
      throw new AuthDomainError({
        status: 429,
        code: 'RATE_LIMITED',
        message: AUTH_MESSAGES.rateLimited(pairState.retryAfterSeconds),
        retryAfterSeconds: pairState.retryAfterSeconds,
        requireCaptcha: pairState.requireCaptcha ? true : undefined,
      });
    }

    if (pairState.requireCaptcha) {
      const captchaToken = input.captchaToken?.trim() ?? '';
      if (!captchaToken) {
        throw new AuthDomainError({
          status: 400,
          code: 'CAPTCHA_REQUIRED',
          message: AUTH_MESSAGES.captchaRequired,
          details: [{ field: 'captchaToken', message: AUTH_MESSAGES.captchaRequired }],
          requireCaptcha: true,
        });
      }

      const captchaResult = await this.captchaProvider.verify({
        token: captchaToken,
        remoteIp: context.ipAddress,
      });
      if (!captchaResult.success) {
        throw new AuthDomainError({
          status: 400,
          code: 'CAPTCHA_INVALID',
          message: AUTH_MESSAGES.captchaInvalid,
          details: [{ field: 'captchaToken', message: AUTH_MESSAGES.captchaInvalid }],
          requireCaptcha: true,
        });
      }
    }

    // 4. Tra cứu danh tính theo email đã chuẩn hóa (ghi mốc thời gian chống timing side-channel).
    const loginStartedAtMs = Date.now();
    const existing = await this.repository.findEmailIdentityWithUser(input.email);
    if (!existing || !existing.identity.passwordHash) {
      // Chạy Argon2id giả cùng chi phí để thời gian phản hồi đồng nhất dù email không tồn tại.
      await verifyDummyPassword();

      // Ghi nhận thất bại theo `(email + IP)` giống hệt nhánh sai mật khẩu để triệt tiêu oracle dò email
      // thông qua việc quan sát ngưỡng kích hoạt Backoff / `requireCaptcha: true`.
      const pairFailure = await this.loginProtection.recordPairFailure(
        input.email,
        context.rateLimitIpKey,
      );

      await this.auditLogService.record({
        userId: existing?.user.id ?? null,
        action: 'LOGIN_FAILED',
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        metadata: {
          provider: 'email_password',
          reason: 'identity_not_found',
          pairFailureCount: pairFailure.failureCount,
        },
      });

      await this.equalizeResponseDuration(loginStartedAtMs, this.minLoginFailureResponseMs);

      throw new AuthDomainError({
        status: 401,
        code: 'INVALID_CREDENTIALS',
        message: AUTH_MESSAGES.invalidCredentials,
        requireCaptcha: pairFailure.requireCaptcha ? true : undefined,
      });
    }

    // 5. Đối chiếu mật khẩu qua Argon2id + Pepper đúng phiên bản.
    const verification = await verifyPassword(
      input.password,
      existing.identity.passwordHash,
      existing.identity.pepperVersion,
      this.pepperProvider,
    );

    if (!verification.valid) {
      const pairFailure = await this.loginProtection.recordPairFailure(
        input.email,
        context.rateLimitIpKey,
      );
      const failedAt = this.now();
      const deviceInfo = parseDeviceInfo(context.userAgent);

      // Tăng nguyên tử `failed_login_attempts` và chuyển `active -> locked` khi chạm ngưỡng 50
      // trong cùng DB transaction khóa `users FOR UPDATE` (chống race condition gửi lặp email khóa).
      const lockOutcome = await this.repository.getDb().transaction(async (tx) => {
        const incremented = await this.repository.incrementFailedLoginAttemptsAndMaybeLock(
          {
            identityId: existing.identity.id,
            userId: existing.user.id,
            lockThreshold: ACCOUNT_LOCK_FAILED_ATTEMPTS_THRESHOLD,
            now: failedAt,
          },
          tx,
        );

        await this.auditLogService.record(
          {
            userId: existing.user.id,
            action: 'LOGIN_FAILED',
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            metadata: {
              provider: 'email_password',
              reason: 'invalid_password',
              pairFailureCount: pairFailure.failureCount,
              failedLoginAttempts: incremented?.failedLoginAttempts ?? null,
            },
          },
          tx,
        );

        if (incremented?.lockedNow) {
          await this.auditLogService.record(
            {
              userId: existing.user.id,
              action: 'ACCOUNT_LOCKED',
              ipAddress: context.ipAddress,
              userAgent: context.userAgent,
              metadata: {
                provider: 'email_password',
                reason: 'brute_force_threshold_reached',
                failedLoginAttempts: incremented.failedLoginAttempts,
                deviceInfo,
              },
            },
            tx,
          );
        }

        return incremented;
      });

      if (lockOutcome?.lockedNow) {
        await this.sendAccountLockedAlertEmailSafe({
          toEmail: existing.identity.identifierNormalized,
          displayName: existing.user.fullName,
          occurredAt: failedAt,
          ipAddress: context.ipAddress,
          deviceInfo,
          failedAttempts: lockOutcome.failedLoginAttempts,
        });
      }

      await this.equalizeResponseDuration(loginStartedAtMs, this.minLoginFailureResponseMs);

      // Ngay cả khi vừa chạm mốc 50 lần sai, vẫn trả `401 INVALID_CREDENTIALS` cho mật khẩu sai
      // để kẻ tấn công không biết email tồn tại hay tài khoản vừa bị khóa (chống User Enumeration).
      throw new AuthDomainError({
        status: 401,
        code: 'INVALID_CREDENTIALS',
        message: AUTH_MESSAGES.invalidCredentials,
        requireCaptcha: pairFailure.requireCaptcha ? true : undefined,
      });
    }

    // 6. Chỉ tiết lộ trạng thái tài khoản sau khi người gọi đã chứng minh biết đúng mật khẩu.
    // Riêng trạng thái `deleted` phải đồng nhất tuyệt đối với email không tồn tại (ghi nhận pairFailure,
    // kích hoạt Backoff/requireCaptcha và cân bằng thời gian phản hồi chống oracle dò tài khoản đã xóa).
    if (existing.user.status === 'deleted') {
      const pairFailure = await this.loginProtection.recordPairFailure(
        input.email,
        context.rateLimitIpKey,
      );
      await this.recordFailedLoginForStatus(existing.user.id, 'deleted', context);
      await this.equalizeResponseDuration(loginStartedAtMs, this.minLoginFailureResponseMs);
      throw new AuthDomainError({
        status: 401,
        code: 'INVALID_CREDENTIALS',
        message: AUTH_MESSAGES.invalidCredentials,
        requireCaptcha: pairFailure.requireCaptcha ? true : undefined,
      });
    }

    if (existing.user.status !== 'active') {
      await this.recordFailedLoginForStatus(existing.user.id, existing.user.status, context);
      this.throwForNonActiveLoginStatus(existing.user.status);
    }

    // 7. Nếu Pepper version hoặc tham số Argon2id đã cũ -> tính toán bản băm mới ngoài DB transaction.
    const rehashed = verification.needsRehash
      ? await hashPassword(input.password, this.pepperProvider)
      : null;

    const currentTime = this.now();

    const loginOutcome = await this.repository
      .getDb()
      .transaction<LoginTransactionOutcome>(async (tx) => {
        // Khóa `users FOR SHARE` và xác minh lại trạng thái `active` bên trong transaction
        // nhằm chặn TOCTOU nếu tài khoản vừa bị khóa/đình chỉ/xóa trong lúc chạy Argon2id (~100-250ms).
        const freshUser = await this.repository.lockUserById(existing.user.id, tx, 'share');
        if (!freshUser) {
          await this.recordFailedLoginForStatus(existing.user.id, 'deleted', context, tx);
          return { kind: 'status_changed', status: 'deleted' };
        }
        if (freshUser.status !== 'active') {
          await this.recordFailedLoginForStatus(existing.user.id, freshUser.status, context, tx);
          return { kind: 'status_changed', status: freshUser.status };
        }

        let rehashApplied = false;
        if (rehashed) {
          // Compare-And-Swap theo `password_hash` hiện tại + `user_id` để không bao giờ ghi đè ngược
          // mật khẩu mới nếu người dùng vừa đổi mật khẩu song song trong lúc Argon2id đang tính toán.
          rehashApplied = await this.repository.updateIdentityPasswordHash(
            {
              identityId: existing.identity.id,
              userId: existing.user.id,
              passwordHash: rehashed.hash,
              pepperVersion: rehashed.pepperVersion,
              expectedCurrentPasswordHash: existing.identity.passwordHash ?? undefined,
              now: currentTime,
            },
            tx,
          );
        }

        // Luôn đặt lại `failed_login_attempts = 0` (kể cả khi một request sai song song vừa tăng trước đó).
        await this.repository.resetFailedLoginAttempts(
          existing.identity.id,
          existing.user.id,
          currentTime,
          tx,
        );

        const issued = await this.sessionService.createSessionForUser(freshUser, context, tx);

        await this.auditLogService.record(
          {
            userId: freshUser.id,
            action: 'LOGIN_SUCCESS',
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            metadata: {
              provider: 'email_password',
              sessionPublicId: issued.session.publicId,
              deviceInfo: issued.session.deviceInfo,
              authUpgradePerformed: rehashApplied,
            },
          },
          tx,
        );

        return { kind: 'created', created: issued, user: freshUser };
      });

    if (loginOutcome.kind === 'status_changed') {
      if (loginOutcome.status === 'deleted') {
        const pairFailure = await this.loginProtection.recordPairFailure(
          input.email,
          context.rateLimitIpKey,
        );
        await this.equalizeResponseDuration(loginStartedAtMs, this.minLoginFailureResponseMs);
        throw new AuthDomainError({
          status: 401,
          code: 'INVALID_CREDENTIALS',
          message: AUTH_MESSAGES.invalidCredentials,
          requireCaptcha: pairFailure.requireCaptcha ? true : undefined,
        });
      }
      this.throwForNonActiveLoginStatus(loginOutcome.status);
    }

    // Đăng nhập thành công -> dọn sạch bộ đếm sai & backoff `(email + IP)` trên Redis (fail-safe).
    await this.loginProtection
      .clearPair(input.email, context.rateLimitIpKey)
      .catch(() => undefined);

    return {
      user: toPublicUserProfile(loginOutcome.user),
      message: AUTH_MESSAGES.loginSuccess,
      tokens: loginOutcome.created.tokens,
    };
  }

  /**
   * Yêu cầu đặt lại mật khẩu qua liên kết dùng một lần (Mục 4.4 — Phương án B UX kiểu Facebook):
   * 1. Rate Limit chạy TRƯỚC theo IP (3/15p), sau khi chuẩn hóa email chạy thêm theo Email (3/15p).
   * 2. Không tìm thấy email hoặc tài khoản đã `deleted` -> `404 NOT_FOUND` rõ ràng;
   *    `pending_verification` / `suspended` -> `403` tương ứng.
   * 3. Tài khoản `active` hoặc `locked` -> khóa `users FOR UPDATE`, vô hiệu hóa mọi token
   *    `password_reset` cũ, sinh token 256-bit (lưu SHA-256, hạn 15 phút) và gửi link qua email.
   */
  async forgotPassword(
    rawInput: unknown,
    context: RequestClientContext,
  ): Promise<ForgotPasswordResult> {
    const ipLimit = await this.rateLimiter.consume(
      `forgot-password:ip:${context.rateLimitIpKey}`,
      AUTH_RATE_LIMITS.forgotPasswordByIp,
    );
    if (!ipLimit.allowed) {
      throw new AuthDomainError({
        status: 429,
        code: 'RATE_LIMITED',
        message: AUTH_MESSAGES.rateLimited(ipLimit.retryAfterSeconds),
        retryAfterSeconds: ipLimit.retryAfterSeconds,
      });
    }

    const parsed = forgotPasswordInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new AuthDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: AUTH_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }
    const { email } = parsed.data;

    const emailLimit = await this.rateLimiter.consume(
      `forgot-password:email:${email}`,
      AUTH_RATE_LIMITS.forgotPasswordByEmail,
    );
    if (!emailLimit.allowed) {
      throw new AuthDomainError({
        status: 429,
        code: 'RATE_LIMITED',
        message: AUTH_MESSAGES.rateLimited(emailLimit.retryAfterSeconds),
        retryAfterSeconds: emailLimit.retryAfterSeconds,
      });
    }

    const existing = await this.repository.findEmailIdentityWithUser(email);
    if (!existing || existing.user.status === 'deleted') {
      throw new AuthDomainError({
        status: 404,
        code: 'NOT_FOUND',
        message: AUTH_MESSAGES.forgotPasswordEmailNotFound,
        details: [{ field: 'email', message: AUTH_MESSAGES.forgotPasswordEmailNotFound }],
      });
    }

    if (existing.user.status === 'pending_verification') {
      throw new AuthDomainError({
        status: 403,
        code: 'EMAIL_NOT_VERIFIED',
        message: AUTH_MESSAGES.emailNotVerified,
      });
    }

    if (existing.user.status === 'suspended') {
      throw new AuthDomainError({
        status: 403,
        code: 'ACCOUNT_SUSPENDED',
        message: AUTH_MESSAGES.accountSuspended,
      });
    }

    const currentTime = this.now();
    const rawResetToken = generateSecureToken(32);
    const resetTokenHash = hashTokenSha256(rawResetToken);
    const expiresAt = new Date(currentTime.getTime() + PASSWORD_RESET_TOKEN_TTL_MS);

    // Khóa `users FOR UPDATE` trong transaction để đảm bảo tại mọi thời điểm chỉ có duy nhất
    // 1 token `password_reset` còn hiệu lực và chặn TOCTOU nếu tài khoản vừa bị đình chỉ/xóa.
    const outcome = await this.repository
      .getDb()
      .transaction<ForgotPasswordTransactionOutcome>(async (tx) => {
        const lockedUser = await this.repository.lockUserById(existing.user.id, tx, 'update');
        if (!lockedUser || lockedUser.status === 'deleted') {
          return { kind: 'not_found' };
        }
        if (lockedUser.status === 'pending_verification') {
          return { kind: 'not_verified' };
        }
        if (lockedUser.status === 'suspended') {
          return { kind: 'suspended' };
        }

        await this.repository.reissueVerificationToken(
          {
            userId: lockedUser.id,
            purpose: 'password_reset',
            tokenHash: resetTokenHash,
            expiresAt,
            now: currentTime,
          },
          tx,
        );

        return { kind: 'issued', user: lockedUser };
      });

    switch (outcome.kind) {
      case 'not_found':
        throw new AuthDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: AUTH_MESSAGES.forgotPasswordEmailNotFound,
          details: [{ field: 'email', message: AUTH_MESSAGES.forgotPasswordEmailNotFound }],
        });
      case 'not_verified':
        throw new AuthDomainError({
          status: 403,
          code: 'EMAIL_NOT_VERIFIED',
          message: AUTH_MESSAGES.emailNotVerified,
        });
      case 'suspended':
        throw new AuthDomainError({
          status: 403,
          code: 'ACCOUNT_SUSPENDED',
          message: AUTH_MESSAGES.accountSuspended,
        });
      case 'issued':
        break;
    }

    const resetUrl = this.buildPasswordResetUrl(rawResetToken);
    await this.sendPasswordResetLinkEmail(email, outcome.user.fullName, resetUrl);

    return {
      message: AUTH_MESSAGES.forgotPasswordSent,
      expiresInMinutes: PASSWORD_RESET_TOKEN_TTL_MINUTES,
    };
  }

  /**
   * Đặt lại mật khẩu bằng token ngẫu nhiên dùng một lần (Mục 4.4):
   * 1. Rate Limit IP chạy TRƯỚC khi truy vấn DB hoặc băm Argon2id.
   * 2. Xác thực token chưa dùng, chưa hết hạn và kiểm tra chính sách mật khẩu mới (12–128 ký tự).
   * 3. Băm Argon2id + CURRENT_PEPPER_VERSION ngoài transaction.
   * 4. Trong DB Transaction (khóa `users FOR UPDATE` -> `verification_tokens FOR UPDATE`):
   *    - Xác minh lại token + trạng thái (`active` hoặc `locked`), mở khóa `locked -> active`,
   *      reset `failed_login_attempts = 0`, tiêu thụ toàn bộ token `password_reset`/`password_change`.
   *    - Thu hồi MỌI phiên đăng nhập cũ trong DB (`reason: 'password_reset'`) và ghi Audit Log `PASSWORD_RESET`.
   * 5. Gửi email cảnh báo bảo mật (kèm thời gian, IP, thiết bị).
   */
  async resetPassword(
    rawInput: unknown,
    context: RequestClientContext,
  ): Promise<ResetPasswordResult> {
    const ipLimit = await this.rateLimiter.consume(
      `reset-password:ip:${context.rateLimitIpKey}`,
      AUTH_RATE_LIMITS.resetPasswordByIp,
    );
    if (!ipLimit.allowed) {
      throw new AuthDomainError({
        status: 429,
        code: 'RATE_LIMITED',
        message: AUTH_MESSAGES.rateLimited(ipLimit.retryAfterSeconds),
        retryAfterSeconds: ipLimit.retryAfterSeconds,
      });
    }

    const parsed = resetPasswordInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new AuthDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: AUTH_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }
    const input = parsed.data;

    const currentTime = this.now();
    const tokenHash = hashTokenSha256(input.token);

    // Tra cứu sơ bộ trước khi băm Argon2id nhằm tránh bị DoS CPU bằng các token giả/hết hạn.
    const candidateToken = await this.repository.findVerificationTokenByHash(
      'password_reset',
      tokenHash,
    );
    if (
      !candidateToken ||
      candidateToken.consumedAt !== null ||
      !timingSafeEqualHex(tokenHash, candidateToken.tokenHash)
    ) {
      throw new AuthDomainError({
        status: 400,
        code: 'TOKEN_INVALID',
        message: AUTH_MESSAGES.resetTokenInvalidOrExpired,
      });
    }

    if (candidateToken.expiresAt.getTime() <= currentTime.getTime()) {
      throw new AuthDomainError({
        status: 400,
        code: 'TOKEN_EXPIRED',
        message: AUTH_MESSAGES.resetTokenExpired,
      });
    }

    const candidateUser = await this.repository.findUserById(candidateToken.userId);
    const candidateIdentity = candidateUser
      ? await this.repository.findEmailIdentityByUserId(candidateUser.id)
      : null;

    if (
      !candidateUser ||
      !candidateIdentity ||
      (candidateUser.status !== 'active' && candidateUser.status !== 'locked')
    ) {
      throw new AuthDomainError({
        status: 400,
        code: 'TOKEN_INVALID',
        message: AUTH_MESSAGES.resetTokenInvalidOrExpired,
      });
    }

    const contextViolation = getWeakPasswordContextViolation(input.newPassword, {
      email: candidateIdentity.identifierNormalized,
      fullName: candidateUser.fullName,
      username: candidateUser.username,
    });
    if (contextViolation) {
      throw new AuthDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: AUTH_MESSAGES.validationFailed,
        details: [{ field: 'newPassword', message: contextViolation }],
      });
    }

    // Băm mật khẩu mới ngoài DB Transaction để không giữ khóa/kết nối PG trong lúc chạy Argon2id.
    const { hash: passwordHash, pepperVersion } = await hashPassword(
      input.newPassword,
      this.pepperProvider,
    );
    const deviceInfo = parseDeviceInfo(context.userAgent);

    // Tuân thủ thứ tự khóa toàn cục (`users FOR UPDATE` -> `verification_tokens FOR UPDATE`
    // -> `auth_identities` -> `sessions`) để triệt tiêu deadlock và chống replay đồng thời 1 token.
    const outcome = await this.repository
      .getDb()
      .transaction<ResetPasswordTransactionOutcome>(async (tx) => {
        const lockedUser = await this.repository.lockUserById(candidateToken.userId, tx, 'update');
        if (!lockedUser || (lockedUser.status !== 'active' && lockedUser.status !== 'locked')) {
          return { kind: 'invalid' };
        }

        const lockedToken = await this.repository.lockVerificationTokenById(
          candidateToken.id,
          lockedUser.id,
          tx,
        );
        if (
          !lockedToken ||
          lockedToken.purpose !== 'password_reset' ||
          lockedToken.consumedAt !== null ||
          !timingSafeEqualHex(tokenHash, lockedToken.tokenHash)
        ) {
          return { kind: 'invalid' };
        }

        if (lockedToken.expiresAt.getTime() <= currentTime.getTime()) {
          await this.repository.consumeVerificationToken(
            lockedToken.id,
            lockedUser.id,
            currentTime,
            tx,
          );
          return { kind: 'expired' };
        }

        const identity = await this.repository.findEmailIdentityByUserId(lockedUser.id, tx);
        if (!identity) {
          return { kind: 'invalid' };
        }

        const freshViolation = getWeakPasswordContextViolation(input.newPassword, {
          email: identity.identifierNormalized,
          fullName: lockedUser.fullName,
          username: lockedUser.username,
        });
        if (freshViolation) {
          return { kind: 'password_violation', message: freshViolation };
        }

        const wasLocked = lockedUser.status === 'locked';
        if (wasLocked) {
          await this.repository.unlockLockedUser(lockedUser.id, currentTime, tx);
        }

        await this.repository.updateIdentityPasswordHash(
          {
            identityId: identity.id,
            userId: lockedUser.id,
            passwordHash,
            pepperVersion,
            now: currentTime,
          },
          tx,
        );

        await this.repository.resetFailedLoginAttempts(identity.id, lockedUser.id, currentTime, tx);

        await this.repository.consumeAllUnconsumedTokensByPurpose(
          lockedUser.id,
          'password_reset',
          currentTime,
          tx,
        );
        await this.repository.consumeAllUnconsumedTokensByPurpose(
          lockedUser.id,
          'password_change',
          currentTime,
          tx,
        );
        await this.repository.consumeAllUnconsumedTokensByPurpose(
          lockedUser.id,
          'password_change_ticket',
          currentTime,
          tx,
        );

        const revokedSessionsCount = await this.repository.revokeAllUserSessions(
          {
            userId: lockedUser.id,
            revokedAt: currentTime,
            reason: 'password_reset',
          },
          tx,
        );

        await this.auditLogService.record(
          {
            userId: lockedUser.id,
            action: 'PASSWORD_RESET',
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            metadata: {
              provider: 'email_password',
              unlockedFromLocked: wasLocked,
              revokedSessionsCount,
              deviceInfo,
            },
          },
          tx,
        );

        return {
          kind: 'reset',
          user: lockedUser,
          email: identity.identifierNormalized,
          unlockedFromLocked: wasLocked,
          revokedSessionsCount,
        };
      });

    switch (outcome.kind) {
      case 'invalid':
        throw new AuthDomainError({
          status: 400,
          code: 'TOKEN_INVALID',
          message: AUTH_MESSAGES.resetTokenInvalidOrExpired,
        });
      case 'expired':
        throw new AuthDomainError({
          status: 400,
          code: 'TOKEN_EXPIRED',
          message: AUTH_MESSAGES.resetTokenExpired,
        });
      case 'password_violation':
        throw new AuthDomainError({
          status: 400,
          code: 'VALIDATION_ERROR',
          message: AUTH_MESSAGES.validationFailed,
          details: [{ field: 'newPassword', message: outcome.message }],
        });
      case 'reset':
        break;
    }

    // Xóa bộ đếm sai `(email + IP)` của IP hiện tại sau khi mở khóa/đặt lại mật khẩu thành công.
    await this.loginProtection
      .clearPair(outcome.email, context.rateLimitIpKey)
      .catch(() => undefined);

    await this.sendPasswordAlertEmailSafe('reset', {
      toEmail: outcome.email,
      displayName: outcome.user.fullName,
      occurredAt: currentTime,
      ipAddress: context.ipAddress,
      deviceInfo,
    });

    return {
      reset: true,
      message: AUTH_MESSAGES.passwordResetSuccess,
    };
  }

  /**
   * Phát hành mã OTP 6 chữ số xác nhận đổi mật khẩu cho người dùng đã đăng nhập (Mục 4.5):
   * - Kiểm tra quyền sở hữu qua `auth.policy.ts` (Deny by default).
   * - Áp dụng cooldown bắt buộc 60 giây + giới hạn IP & giới hạn giờ theo `user.id`.
   * - Vô hiệu hóa mọi OTP `password_change` cũ chưa dùng, tạo mã OTP mới (hạn 10 phút, HMAC-SHA256)
   *   và gửi tới email chủ tài khoản.
   */
  async requestPasswordChangeOtp(
    principal: AuthenticatedPrincipal,
    context: RequestClientContext,
  ): Promise<RequestPasswordChangeOtpResult> {
    assertCanChangeOwnPassword(principal);

    const ipLimit = await this.rateLimiter.consume(
      `change-password-otp:ip:${context.rateLimitIpKey}`,
      AUTH_RATE_LIMITS.changePasswordOtpByIp,
    );
    if (!ipLimit.allowed) {
      throw new AuthDomainError({
        status: 429,
        code: 'RATE_LIMITED',
        message: AUTH_MESSAGES.rateLimited(ipLimit.retryAfterSeconds),
        retryAfterSeconds: ipLimit.retryAfterSeconds,
      });
    }

    // Kiểm tra cooldown 60 giây trước hạn mức giờ để tránh nhấn lặp làm tiêu hao lượt giờ.
    const cooldownLimit = await this.rateLimiter.consume(
      `change-password-otp:cooldown:${principal.user.id}`,
      AUTH_RATE_LIMITS.changePasswordOtpCooldown,
    );
    if (!cooldownLimit.allowed) {
      throw new AuthDomainError({
        status: 429,
        code: 'RATE_LIMITED',
        message: AUTH_MESSAGES.changePasswordOtpCooldown(cooldownLimit.retryAfterSeconds),
        retryAfterSeconds: cooldownLimit.retryAfterSeconds,
      });
    }

    const hourlyLimit = await this.rateLimiter.consume(
      `change-password-otp:user1h:${principal.user.id}`,
      AUTH_RATE_LIMITS.changePasswordOtpByUserHourly,
    );
    if (!hourlyLimit.allowed) {
      throw new AuthDomainError({
        status: 429,
        code: 'RATE_LIMITED',
        message: AUTH_MESSAGES.rateLimited(hourlyLimit.retryAfterSeconds),
        retryAfterSeconds: hourlyLimit.retryAfterSeconds,
      });
    }

    const currentTime = this.now();
    const otpCode = generateOtpCode();
    const otpTokenHash = hashOtpCode(otpCode, {
      userId: principal.user.id,
      purpose: 'password_change',
    });
    const otpExpiresAt = new Date(currentTime.getTime() + PASSWORD_CHANGE_OTP_TTL_MS);

    const outcome = await this.repository
      .getDb()
      .transaction<RequestPasswordChangeOtpTransactionOutcome>(async (tx) => {
        const lockedUser = await this.repository.lockUserById(principal.user.id, tx, 'update');
        if (!lockedUser || lockedUser.status !== 'active') {
          return { kind: 'unauthorized' };
        }

        const currentSession = await this.repository.findSessionByPublicIdForUser(
          principal.session.publicId,
          lockedUser.id,
          tx,
        );
        if (!currentSession || !isSessionCurrentlyActive(currentSession, currentTime)) {
          return { kind: 'unauthorized' };
        }

        const identity = await this.repository.findEmailIdentityByUserId(lockedUser.id, tx);
        if (!identity) {
          return { kind: 'unauthorized' };
        }

        await this.repository.reissueVerificationToken(
          {
            userId: lockedUser.id,
            purpose: 'password_change',
            tokenHash: otpTokenHash,
            expiresAt: otpExpiresAt,
            now: currentTime,
          },
          tx,
        );
        // Vô hiệu hóa mọi ticket Bước 2 cũ khi người dùng bắt đầu chu kỳ xác thực OTP mới.
        await this.repository.consumeAllUnconsumedTokensByPurpose(
          lockedUser.id,
          'password_change_ticket',
          currentTime,
          tx,
        );

        return {
          kind: 'issued',
          user: lockedUser,
          email: identity.identifierNormalized,
        };
      });

    if (outcome.kind === 'unauthorized') {
      throw new AuthDomainError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: AUTH_MESSAGES.unauthorized,
      });
    }

    await this.sendPasswordChangeOtpEmail(outcome.email, outcome.user.fullName, otpCode);

    return {
      message: AUTH_MESSAGES.changePasswordOtpSent,
      cooldownSeconds: CHANGE_PASSWORD_OTP_COOLDOWN_SECONDS,
      expiresInMinutes: PASSWORD_CHANGE_OTP_TTL_MINUTES,
    };
  }

  /**
   * Bước 1b đổi mật khẩu: xác minh mã OTP `password_change` đã gửi qua email và cấp ticket dùng một lần
   * (thời hạn 10 phút, gắn chặt với `(userId, session.familyId)` qua SHA-256) để mở khóa Bước 2.
   * - Gắn với `session.familyId` thay vì `session.id` để nếu Silent Refresh xoay vòng RT giữa Bước 1 và Bước 2
   *   trên cùng thiết bị thì phiên xác nhận vẫn hợp lệ, nhưng thiết bị khác hoặc tài khoản khác tuyệt đối không dùng được.
   */
  async verifyPasswordChangeOtp(
    principal: AuthenticatedPrincipal,
    rawInput: unknown,
    context: RequestClientContext,
  ): Promise<VerifyPasswordChangeOtpResult> {
    assertCanChangeOwnPassword(principal);

    const ipLimit = await this.rateLimiter.consume(
      `change-password-verify:ip:${context.rateLimitIpKey}`,
      AUTH_RATE_LIMITS.changePasswordVerifyOtpByIp,
    );
    if (!ipLimit.allowed) {
      throw new AuthDomainError({
        status: 429,
        code: 'RATE_LIMITED',
        message: AUTH_MESSAGES.rateLimited(ipLimit.retryAfterSeconds),
        retryAfterSeconds: ipLimit.retryAfterSeconds,
      });
    }

    const userLimit = await this.rateLimiter.consume(
      `change-password-verify:user:${principal.user.id}`,
      AUTH_RATE_LIMITS.changePasswordVerifyOtpByUser,
    );
    if (!userLimit.allowed) {
      throw new AuthDomainError({
        status: 429,
        code: 'RATE_LIMITED',
        message: AUTH_MESSAGES.rateLimited(userLimit.retryAfterSeconds),
        retryAfterSeconds: userLimit.retryAfterSeconds,
      });
    }

    const parsed = verifyPasswordChangeOtpInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new AuthDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: AUTH_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }
    const input = parsed.data;
    const currentTime = this.now();

    // Trả về kết quả phân nhánh (không throw trong tx) để việc tăng `attempt_count` / hủy OTP sau 5 lần sai
    // luôn được COMMIT bền vững xuống PostgreSQL.
    const outcome = await this.repository
      .getDb()
      .transaction<VerifyPasswordChangeOtpTransactionOutcome>(async (tx) => {
        const lockedUser = await this.repository.lockUserById(principal.user.id, tx, 'update');
        if (!lockedUser || lockedUser.status !== 'active') {
          return { kind: 'unauthorized' };
        }

        const currentSession = await this.repository.findSessionByPublicIdForUser(
          principal.session.publicId,
          lockedUser.id,
          tx,
        );
        if (!currentSession || !isSessionCurrentlyActive(currentSession, currentTime)) {
          return { kind: 'unauthorized' };
        }

        const token = await this.repository.lockLatestUnconsumedTokenByPurpose(
          lockedUser.id,
          'password_change',
          tx,
        );
        if (!token) {
          return { kind: 'otp_invalid' };
        }

        if (token.expiresAt.getTime() <= currentTime.getTime()) {
          await this.repository.consumeVerificationToken(token.id, lockedUser.id, currentTime, tx);
          return { kind: 'otp_expired' };
        }

        if (token.attemptCount >= PASSWORD_CHANGE_OTP_MAX_ATTEMPTS) {
          await this.repository.consumeVerificationToken(token.id, lockedUser.id, currentTime, tx);
          return { kind: 'otp_max_attempts' };
        }

        const matched = verifyOtpCode(input.otpCode, token.tokenHash, {
          userId: lockedUser.id,
          purpose: 'password_change',
        });
        if (!matched) {
          const nextAttempts = token.attemptCount + 1;
          const exhausted = nextAttempts >= PASSWORD_CHANGE_OTP_MAX_ATTEMPTS;
          await this.repository.updateVerificationTokenAttempt(
            token.id,
            lockedUser.id,
            nextAttempts,
            exhausted ? currentTime : null,
            tx,
          );
          if (exhausted) {
            return { kind: 'otp_max_attempts' };
          }
          return {
            kind: 'otp_wrong',
            remainingAttempts: PASSWORD_CHANGE_OTP_MAX_ATTEMPTS - nextAttempts,
          };
        }

        // Tiêu thụ dứt điểm OTP Bước 1 và phát hành ticket 256-bit dùng một lần cho Bước 2.
        await this.repository.consumeAllUnconsumedTokensByPurpose(
          lockedUser.id,
          'password_change',
          currentTime,
          tx,
        );

        const rawTicket = generateSecureToken(32);
        const ticketHash = hashScopedTokenSha256(rawTicket, {
          purpose: 'password_change_ticket',
          userId: lockedUser.id,
          sessionFamilyId: currentSession.familyId,
        });

        await this.repository.reissueVerificationToken(
          {
            userId: lockedUser.id,
            purpose: 'password_change_ticket',
            tokenHash: ticketHash,
            expiresAt: new Date(currentTime.getTime() + PASSWORD_CHANGE_TICKET_TTL_MS),
            now: currentTime,
          },
          tx,
        );

        return { kind: 'issued', rawTicket };
      });

    switch (outcome.kind) {
      case 'unauthorized':
        throw new AuthDomainError({
          status: 401,
          code: 'UNAUTHORIZED',
          message: AUTH_MESSAGES.unauthorized,
        });
      case 'otp_invalid':
        throw new AuthDomainError({
          status: 400,
          code: 'TOKEN_INVALID',
          message: AUTH_MESSAGES.otpInvalidOrExpired,
          details: [{ field: 'otpCode', message: AUTH_MESSAGES.otpInvalidOrExpired }],
        });
      case 'otp_expired':
        throw new AuthDomainError({
          status: 400,
          code: 'TOKEN_EXPIRED',
          message: AUTH_MESSAGES.otpExpired,
          details: [{ field: 'otpCode', message: AUTH_MESSAGES.otpExpired }],
        });
      case 'otp_max_attempts':
        throw new AuthDomainError({
          status: 400,
          code: 'TOKEN_INVALID',
          message: AUTH_MESSAGES.otpRevokedMaxAttempts,
          details: [{ field: 'otpCode', message: AUTH_MESSAGES.otpRevokedMaxAttempts }],
        });
      case 'otp_wrong': {
        const wrongMsg = AUTH_MESSAGES.otpIncorrectWithRemaining(outcome.remainingAttempts);
        throw new AuthDomainError({
          status: 400,
          code: 'TOKEN_INVALID',
          message: wrongMsg,
          details: [{ field: 'otpCode', message: wrongMsg }],
        });
      }
      case 'issued':
        return {
          verified: true,
          expiresInMinutes: PASSWORD_CHANGE_TICKET_TTL_MINUTES,
          message: AUTH_MESSAGES.changePasswordOtpVerified,
          ticket: outcome.rawTicket,
        };
    }
  }

  /**
   * Bước 2 đổi mật khẩu khi đã đăng nhập (server-enforced 2-step flow):
   * 1. Rate Limit IP + User chạy TRƯỚC mọi xử lý mật mã/DB nặng.
   * 2. Bắt buộc phải có ticket dùng một lần hợp lệ từ Bước 1 (`HttpOnly` cookie, gắn với `(userId, session.familyId)`).
   *    Tuyệt đối không cho phép nhảy thẳng vào Bước 2 khi chưa hoàn tất Bước 1.
   * 3. Xác thực `currentPassword` và `newPassword`, đảm bảo `newPassword !== currentPassword` và mật khẩu mạnh.
   * 4. Pre-check ticket trước Argon2id để tránh lãng phí CPU; nếu sai `currentPassword` sẽ tăng bộ đếm sai
   *    trên ticket (tối đa 5 lần -> tự hủy ticket, bắt xác minh lại Bước 1).
   * 5. Trong DB Transaction:
   *    - Khóa `users FOR UPDATE` -> `advisory(familyId)` -> `verification_tokens FOR UPDATE` -> `sessions`.
   *    - Kiểm tra lại ticket + CAS `password_hash` hiện tại.
   *    - Cập nhật `password_hash` + `pepper_version` mới, tiêu thụ sạch mọi ticket/OTP/reset token,
   *      thu hồi mọi phiên thiết bị khác, xoay vòng hoàn toàn phiên hiện tại (chống session fixation).
   *    - Ghi Audit Log `PASSWORD_CHANGED` và gửi email cảnh báo bảo mật (fail-safe).
   */
  async changePassword(
    principal: AuthenticatedPrincipal,
    rawInput: unknown,
    rawTicket: string | null,
    context: RequestClientContext,
  ): Promise<ChangePasswordResult> {
    assertCanChangeOwnPassword(principal);

    const ipLimit = await this.rateLimiter.consume(
      `change-password:ip:${context.rateLimitIpKey}`,
      AUTH_RATE_LIMITS.changePasswordByIp,
    );
    if (!ipLimit.allowed) {
      throw new AuthDomainError({
        status: 429,
        code: 'RATE_LIMITED',
        message: AUTH_MESSAGES.rateLimited(ipLimit.retryAfterSeconds),
        retryAfterSeconds: ipLimit.retryAfterSeconds,
      });
    }

    const userLimit = await this.rateLimiter.consume(
      `change-password:user:${principal.user.id}`,
      AUTH_RATE_LIMITS.changePasswordByUser,
    );
    if (!userLimit.allowed) {
      throw new AuthDomainError({
        status: 429,
        code: 'RATE_LIMITED',
        message: AUTH_MESSAGES.rateLimited(userLimit.retryAfterSeconds),
        retryAfterSeconds: userLimit.retryAfterSeconds,
      });
    }

    // Chặn tuyệt đối mọi yêu cầu nhảy cóc Bước 1 trước khi chạy Zod/Argon2id.
    const normalizedTicket = rawTicket?.trim() ?? '';
    if (normalizedTicket.length < 32 || normalizedTicket.length > 256) {
      throw new AuthDomainError({
        status: 403,
        code: 'TOKEN_INVALID',
        message: AUTH_MESSAGES.changePasswordTicketRequired,
        clearPasswordChangeTicket: true,
      });
    }

    const parsed = changePasswordInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new AuthDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: AUTH_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }
    const input = parsed.data;

    const identity = await this.repository.findEmailIdentityByUserId(principal.user.id);
    if (!identity || !identity.passwordHash) {
      throw new AuthDomainError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: AUTH_MESSAGES.unauthorized,
      });
    }

    const contextViolation = getWeakPasswordContextViolation(input.newPassword, {
      email: identity.identifierNormalized,
      fullName: principal.user.fullName,
      username: principal.user.username,
    });
    if (contextViolation) {
      throw new AuthDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: AUTH_MESSAGES.validationFailed,
        details: [{ field: 'newPassword', message: contextViolation }],
      });
    }

    // Ràng buộc ticket vào đúng `(purpose, userId, session.familyId)` để chặn dùng chéo user/thiết bị.
    const ticketHash = hashScopedTokenSha256(normalizedTicket, {
      purpose: 'password_change_ticket',
      userId: principal.user.id,
      sessionFamilyId: principal.session.familyId,
    });

    // Pre-check ticket trước khi tốn CPU chạy Argon2id.
    const precheckTime = this.now();
    const candidateTicket = await this.repository.findVerificationTokenByHashForUser(
      principal.user.id,
      'password_change_ticket',
      ticketHash,
    );
    if (
      !candidateTicket ||
      candidateTicket.consumedAt !== null ||
      !timingSafeEqualHex(candidateTicket.tokenHash, ticketHash)
    ) {
      throw new AuthDomainError({
        status: 403,
        code: 'TOKEN_INVALID',
        message: AUTH_MESSAGES.changePasswordTicketInvalid,
        clearPasswordChangeTicket: true,
      });
    }
    if (candidateTicket.expiresAt.getTime() <= precheckTime.getTime()) {
      throw new AuthDomainError({
        status: 403,
        code: 'TOKEN_EXPIRED',
        message: AUTH_MESSAGES.changePasswordTicketExpired,
        clearPasswordChangeTicket: true,
      });
    }
    if (candidateTicket.attemptCount >= PASSWORD_CHANGE_TICKET_MAX_ATTEMPTS) {
      throw new AuthDomainError({
        status: 403,
        code: 'TOKEN_INVALID',
        message: AUTH_MESSAGES.changePasswordTicketRevokedMaxAttempts,
        clearPasswordChangeTicket: true,
      });
    }

    // Xác minh mật khẩu hiện tại ngoài DB Transaction để không giữ row lock khi chạy Argon2id.
    const currentVerification = await verifyPassword(
      input.currentPassword,
      identity.passwordHash,
      identity.pepperVersion,
      this.pepperProvider,
    );
    if (!currentVerification.valid) {
      const failNow = this.now();
      const attemptOutcome = await this.repository
        .getDb()
        .transaction<
          'unauthorized' | 'ticket_invalid' | 'ticket_expired' | 'ticket_max_attempts' | 'wrong'
        >(async (tx) => {
          const lockedUser = await this.repository.lockUserById(principal.user.id, tx, 'update');
          if (!lockedUser || lockedUser.status !== 'active') {
            return 'unauthorized';
          }
          const currentSession = await this.repository.findSessionByPublicIdForUser(
            principal.session.publicId,
            lockedUser.id,
            tx,
          );
          if (
            !currentSession ||
            !isSessionCurrentlyActive(currentSession, failNow) ||
            currentSession.familyId !== principal.session.familyId
          ) {
            return 'unauthorized';
          }
          const ticket = await this.repository.lockVerificationTokenByHashForUser(
            lockedUser.id,
            'password_change_ticket',
            ticketHash,
            tx,
          );
          if (!ticket || ticket.consumedAt !== null) {
            return 'ticket_invalid';
          }
          if (ticket.expiresAt.getTime() <= failNow.getTime()) {
            await this.repository.consumeVerificationToken(ticket.id, lockedUser.id, failNow, tx);
            return 'ticket_expired';
          }
          if (ticket.attemptCount >= PASSWORD_CHANGE_TICKET_MAX_ATTEMPTS) {
            await this.repository.consumeVerificationToken(ticket.id, lockedUser.id, failNow, tx);
            return 'ticket_max_attempts';
          }
          const nextAttempts = ticket.attemptCount + 1;
          const exhausted = nextAttempts >= PASSWORD_CHANGE_TICKET_MAX_ATTEMPTS;
          await this.repository.updateVerificationTokenAttempt(
            ticket.id,
            lockedUser.id,
            nextAttempts,
            exhausted ? failNow : null,
            tx,
          );
          return exhausted ? 'ticket_max_attempts' : 'wrong';
        });

      if (attemptOutcome === 'unauthorized') {
        throw new AuthDomainError({
          status: 401,
          code: 'UNAUTHORIZED',
          message: AUTH_MESSAGES.unauthorized,
        });
      }
      if (attemptOutcome === 'ticket_invalid') {
        throw new AuthDomainError({
          status: 403,
          code: 'TOKEN_INVALID',
          message: AUTH_MESSAGES.changePasswordTicketInvalid,
          clearPasswordChangeTicket: true,
        });
      }
      if (attemptOutcome === 'ticket_expired') {
        throw new AuthDomainError({
          status: 403,
          code: 'TOKEN_EXPIRED',
          message: AUTH_MESSAGES.changePasswordTicketExpired,
          clearPasswordChangeTicket: true,
        });
      }
      if (attemptOutcome === 'ticket_max_attempts') {
        throw new AuthDomainError({
          status: 403,
          code: 'TOKEN_INVALID',
          message: AUTH_MESSAGES.changePasswordTicketRevokedMaxAttempts,
          clearPasswordChangeTicket: true,
        });
      }

      throw new AuthDomainError({
        status: 400,
        code: 'INVALID_CREDENTIALS',
        message: AUTH_MESSAGES.currentPasswordIncorrect,
        details: [{ field: 'currentPassword', message: AUTH_MESSAGES.currentPasswordIncorrect }],
      });
    }

    // Băm mật khẩu mới bằng Argon2id + CURRENT_PEPPER_VERSION ngoài transaction.
    const { hash: newPasswordHash, pepperVersion } = await hashPassword(
      input.newPassword,
      this.pepperProvider,
    );

    const currentTime = this.now();
    const expectedPreviousHash = identity.passwordHash;

    // Quan trọng: trả về kết quả phân nhánh cho các nhánh lỗi ticket trước khi ghi dữ liệu mới
    // để việc đánh dấu hết hạn/hủy ticket được COMMIT. Mọi lỗi SAU khi đã ghi mật khẩu phải `throw` để ROLLBACK.
    const outcome = await this.repository
      .getDb()
      .transaction<ChangePasswordTransactionOutcome>(async (tx) => {
        const lockedUser = await this.repository.lockUserById(principal.user.id, tx, 'update');
        if (!lockedUser || lockedUser.status !== 'active') {
          return { kind: 'unauthorized' };
        }

        const currentSession = await this.repository.findSessionByPublicIdForUser(
          principal.session.publicId,
          lockedUser.id,
          tx,
        );
        if (
          !currentSession ||
          !isSessionCurrentlyActive(currentSession, currentTime) ||
          currentSession.familyId !== principal.session.familyId
        ) {
          return { kind: 'unauthorized' };
        }

        // Tuân thủ thứ tự khóa toàn cục (`users FOR UPDATE` -> `advisory(familyId)` -> `verification_tokens` -> `sessions`)
        // TRƯỚC khi thực hiện bất kỳ thao tác ghi nào.
        await this.repository.acquireSessionFamilyLock(currentSession.familyId, tx);

        const freshIdentity = await this.repository.findEmailIdentityByUserId(lockedUser.id, tx);
        if (!freshIdentity || freshIdentity.passwordHash !== expectedPreviousHash) {
          return { kind: 'conflict' };
        }

        const ticket = await this.repository.lockVerificationTokenByHashForUser(
          lockedUser.id,
          'password_change_ticket',
          ticketHash,
          tx,
        );
        if (
          !ticket ||
          ticket.consumedAt !== null ||
          !timingSafeEqualHex(ticket.tokenHash, ticketHash)
        ) {
          return { kind: 'ticket_invalid' };
        }

        if (ticket.expiresAt.getTime() <= currentTime.getTime()) {
          await this.repository.consumeVerificationToken(ticket.id, lockedUser.id, currentTime, tx);
          return { kind: 'ticket_expired' };
        }

        if (ticket.attemptCount >= PASSWORD_CHANGE_TICKET_MAX_ATTEMPTS) {
          await this.repository.consumeVerificationToken(ticket.id, lockedUser.id, currentTime, tx);
          return { kind: 'ticket_max_attempts' };
        }

        const updatedPassword = await this.repository.updateIdentityPasswordHash(
          {
            identityId: freshIdentity.id,
            userId: lockedUser.id,
            passwordHash: newPasswordHash,
            pepperVersion,
            expectedCurrentPasswordHash: expectedPreviousHash,
            now: currentTime,
          },
          tx,
        );
        if (!updatedPassword) {
          return { kind: 'conflict' };
        }

        await this.repository.resetFailedLoginAttempts(
          freshIdentity.id,
          lockedUser.id,
          currentTime,
          tx,
        );

        await this.repository.consumeAllUnconsumedTokensByPurpose(
          lockedUser.id,
          'password_change_ticket',
          currentTime,
          tx,
        );
        await this.repository.consumeAllUnconsumedTokensByPurpose(
          lockedUser.id,
          'password_change',
          currentTime,
          tx,
        );
        // Vô hiệu hóa luôn mọi link quên mật khẩu còn tồn đọng khi chủ tài khoản vừa chủ động đổi mật khẩu.
        await this.repository.consumeAllUnconsumedTokensByPurpose(
          lockedUser.id,
          'password_reset',
          currentTime,
          tx,
        );

        // 1. Thu hồi tất cả các phiên trên thiết bị khác.
        const revokedOtherSessionsCount = await this.repository.revokeAllUserSessions(
          {
            userId: lockedUser.id,
            excludeSessionId: currentSession.id,
            revokedAt: currentTime,
            reason: 'password_changed',
          },
          tx,
        );

        // 2. Xoay vòng hoàn toàn phiên của thiết bị hiện tại (chống session fixation):
        //    thu hồi phiên cũ để token AT/RT cũ không thể tái sử dụng rồi phát hành phiên + family_id mới.
        const rotatedOldSession = await this.repository.revokeSessionById(
          currentSession.id,
          lockedUser.id,
          currentTime,
          'password_changed_rotated',
          tx,
        );
        if (!rotatedOldSession) {
          // Bắt buộc `throw` để PostgreSQL ROLLBACK toàn bộ cập nhật mật khẩu & thu hồi phiên
          // thay vì commit nửa vời không cấp được phiên mới cho thiết bị hiện tại.
          throw new AuthDomainError({
            status: 401,
            code: 'UNAUTHORIZED',
            message: AUTH_MESSAGES.unauthorized,
          });
        }

        const created = await this.sessionService.createSessionForUser(lockedUser, context, tx);

        await this.auditLogService.record(
          {
            userId: lockedUser.id,
            action: 'PASSWORD_CHANGED',
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            metadata: {
              provider: 'email_password',
              revokedOtherSessionsCount,
              previousSessionPublicId: currentSession.publicId,
              newSessionPublicId: created.session.publicId,
              deviceInfo: created.session.deviceInfo,
            },
          },
          tx,
        );

        return {
          kind: 'changed',
          user: lockedUser,
          email: freshIdentity.identifierNormalized,
          created,
          revokedOtherSessionsCount,
        };
      });

    switch (outcome.kind) {
      case 'unauthorized':
        throw new AuthDomainError({
          status: 401,
          code: 'UNAUTHORIZED',
          message: AUTH_MESSAGES.unauthorized,
        });
      case 'conflict':
        throw new AuthDomainError({
          status: 409,
          code: 'CONFLICT',
          message: AUTH_MESSAGES.passwordChangeConcurrentConflict,
        });
      case 'ticket_invalid':
        throw new AuthDomainError({
          status: 403,
          code: 'TOKEN_INVALID',
          message: AUTH_MESSAGES.changePasswordTicketInvalid,
          clearPasswordChangeTicket: true,
        });
      case 'ticket_expired':
        throw new AuthDomainError({
          status: 403,
          code: 'TOKEN_EXPIRED',
          message: AUTH_MESSAGES.changePasswordTicketExpired,
          clearPasswordChangeTicket: true,
        });
      case 'ticket_max_attempts':
        throw new AuthDomainError({
          status: 403,
          code: 'TOKEN_INVALID',
          message: AUTH_MESSAGES.changePasswordTicketRevokedMaxAttempts,
          clearPasswordChangeTicket: true,
        });
      case 'changed':
        break;
    }

    await this.sendPasswordAlertEmailSafe('changed', {
      toEmail: outcome.email,
      displayName: outcome.user.fullName,
      occurredAt: currentTime,
      ipAddress: context.ipAddress,
      deviceInfo: outcome.created.session.deviceInfo ?? parseDeviceInfo(context.userAgent),
    });

    return {
      changed: true,
      revokedOtherSessionsCount: outcome.revokedOtherSessionsCount,
      message: AUTH_MESSAGES.passwordChangedSuccess,
      tokens: outcome.created.tokens,
    };
  }

  private async handleExistingAccountRegistration(
    existing: IdentityWithUser,
    input: {
      readonly email: string;
      readonly password: string;
      readonly username: string;
      readonly fullName: string;
      readonly gender: UserGender;
      readonly dateOfBirth: string;
    },
    context: RequestClientContext,
    currentTime: Date,
  ): Promise<void> {
    if (existing.user.status === 'pending_verification') {
      const ageMs = currentTime.getTime() - existing.user.updatedAt.getTime();

      if (ageMs >= PENDING_VERIFICATION_EXPIRY_MS) {
        if (input.username !== existing.user.username) {
          const usernameOwner = await this.repository.findUserByUsername(input.username);
          const reservedByOther =
            typeof this.repository.isHandleReservedByOtherUser === 'function'
              ? await this.repository.isHandleReservedByOtherUser(
                  input.username,
                  existing.user.id,
                  currentTime,
                )
              : false;
          if ((usernameOwner && usernameOwner.id !== existing.user.id) || reservedByOther) {
            throw new AuthDomainError({
              status: 409,
              code: 'CONFLICT',
              message: AUTH_MESSAGES.usernameAlreadyExists,
              details: [{ field: 'username', message: AUTH_MESSAGES.usernameAlreadyExists }],
            });
          }
        }

        // Tài khoản chưa xác minh đã quá hạn (>= 24 giờ): cho phép đăng ký đè sạch sẽ (Mục 4.1).
        const { hash: passwordHash, pepperVersion } = await hashPassword(
          input.password,
          this.pepperProvider,
        );
        const otpCode = generateOtpCode();
        const otpTokenHash = hashOtpCode(otpCode, {
          userId: existing.user.id,
          purpose: 'email_verify',
        });
        const otpExpiresAt = new Date(currentTime.getTime() + EMAIL_VERIFY_OTP_TTL_MS);
        const expiryCutoff = new Date(currentTime.getTime() - PENDING_VERIFICATION_EXPIRY_MS);

        let overwriteOutcome;
        try {
          overwriteOutcome = await this.repository.getDb().transaction(async (tx) => {
            const outcome = await this.repository.overwriteExpiredPendingUserWithOtp(
              {
                userId: existing.user.id,
                identityId: existing.identity.id,
                username: input.username,
                fullName: input.fullName,
                gender: input.gender,
                dateOfBirth: input.dateOfBirth,
                passwordHash,
                pepperVersion,
                otpTokenHash,
                otpExpiresAt,
                expiryCutoff,
                now: currentTime,
              },
              tx,
            );

            if (outcome === 'overwritten') {
              await this.auditLogService.record(
                {
                  userId: existing.user.id,
                  action: 'REGISTER',
                  ipAddress: context.ipAddress,
                  userAgent: context.userAgent,
                  metadata: {
                    provider: 'email_password',
                    outcome: 'pending_expired_overwritten',
                  },
                },
                tx,
              );
            }

            return outcome;
          });
        } catch (error) {
          if (
            isPostgresUniqueViolation(error, 'users_username_unique') ||
            isPostgresUniqueViolation(error, 'idx_users_handle_norm')
          ) {
            throw new AuthDomainError({
              status: 409,
              code: 'CONFLICT',
              message: AUTH_MESSAGES.usernameAlreadyExists,
              details: [{ field: 'username', message: AUTH_MESSAGES.usernameAlreadyExists }],
            });
          }
          throw error;
        }

        if (overwriteOutcome === 'not_pending') {
          await this.auditLogService.record({
            userId: existing.user.id,
            action: 'REGISTER',
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            metadata: {
              provider: 'email_password',
              outcome: 'duplicate_existing_account',
            },
          });

          throw new AuthDomainError({
            status: 409,
            code: 'CONFLICT',
            message: AUTH_MESSAGES.emailAlreadyExists,
            details: [{ field: 'email', message: AUTH_MESSAGES.emailAlreadyExists }],
          });
        }

        if (overwriteOutcome === 'overwritten') {
          await this.rateLimiter.consume(
            `resend:cooldown:${input.email}`,
            AUTH_RATE_LIMITS.resendVerificationCooldown,
          );
          await this.sendVerificationOtpEmail(input.email, input.fullName, otpCode);
        }
        return;
      }

      // Tài khoản `pending_verification` còn trong hạn (< 24 giờ): TUYỆT ĐỐI không ghi đè mật khẩu
      // (chống pre-account takeover), chỉ cấp lại OTP mới (nếu hết cooldown) và vô hiệu hóa OTP cũ.
      const cooldown = await this.rateLimiter.consume(
        `resend:cooldown:${input.email}`,
        AUTH_RATE_LIMITS.resendVerificationCooldown,
      );

      if (!cooldown.allowed) {
        // Chạy 1 lượt Argon2id giả để cân bằng thời gian phản hồi 202 với luồng tạo tài khoản mới
        // (Rate Limit IP + Turnstile đã xác thực ở bước trên).
        await verifyDummyPassword();
        await this.auditLogService.record({
          userId: existing.user.id,
          action: 'REGISTER',
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          metadata: {
            provider: 'email_password',
            outcome: 'pending_cooldown_suppressed',
          },
        });
        return;
      }

      const otpCode = generateOtpCode();
      const otpTokenHash = hashOtpCode(otpCode, {
        userId: existing.user.id,
        purpose: 'email_verify',
      });
      const otpExpiresAt = new Date(currentTime.getTime() + EMAIL_VERIFY_OTP_TTL_MS);

      const reissueOutcome = await this.repository.getDb().transaction(async (tx) => {
        const lockedUser = await this.repository.lockUserById(existing.user.id, tx, 'update');
        if (!lockedUser || lockedUser.status !== 'pending_verification') {
          return 'not_pending' as const;
        }

        await this.repository.reissueEmailVerifyToken(
          {
            userId: existing.user.id,
            otpTokenHash,
            otpExpiresAt,
            now: currentTime,
          },
          tx,
        );

        await this.auditLogService.record(
          {
            userId: existing.user.id,
            action: 'REGISTER',
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            metadata: {
              provider: 'email_password',
              outcome: 'pending_reissued',
            },
          },
          tx,
        );

        return 'reissued' as const;
      });

      if (reissueOutcome === 'not_pending') {
        await this.auditLogService.record({
          userId: existing.user.id,
          action: 'REGISTER',
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          metadata: {
            provider: 'email_password',
            outcome: 'duplicate_existing_account',
          },
        });

        throw new AuthDomainError({
          status: 409,
          code: 'CONFLICT',
          message: AUTH_MESSAGES.emailAlreadyExists,
          details: [{ field: 'email', message: AUTH_MESSAGES.emailAlreadyExists }],
        });
      }

      await verifyDummyPassword();
      await this.sendVerificationOtpEmail(input.email, existing.user.fullName, otpCode);
      return;
    }

    // Email đã được đăng ký (active / locked / suspended / deleted): trả lỗi 409 rõ ràng để điều hướng sang Đăng nhập (Mục 4.1).
    await this.auditLogService.record({
      userId: existing.user.id,
      action: 'REGISTER',
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: {
        provider: 'email_password',
        outcome: 'duplicate_existing_account',
        accountStatus: existing.user.status,
      },
    });

    throw new AuthDomainError({
      status: 409,
      code: 'CONFLICT',
      message: AUTH_MESSAGES.emailAlreadyExists,
      details: [{ field: 'email', message: AUTH_MESSAGES.emailAlreadyExists }],
    });
  }

  private async handleConcurrentDuplicateRegistration(
    emailNormalized: string,
    context: RequestClientContext,
    preloadedWinner?: IdentityWithUser | null,
  ): Promise<void> {
    const winner =
      preloadedWinner !== undefined
        ? preloadedWinner
        : await this.repository.findEmailIdentityWithUser(emailNormalized);

    await this.auditLogService.record({
      userId: winner?.user.id ?? null,
      action: 'REGISTER',
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: {
        provider: 'email_password',
        outcome: 'race_condition_duplicate',
      },
    });

    if (winner && winner.user.status !== 'pending_verification') {
      throw new AuthDomainError({
        status: 409,
        code: 'CONFLICT',
        message: AUTH_MESSAGES.emailAlreadyExists,
        details: [{ field: 'email', message: AUTH_MESSAGES.emailAlreadyExists }],
      });
    }
  }

  private async recordFailedLoginForStatus(
    userId: string,
    status: Exclude<UserStatus, 'active'>,
    context: RequestClientContext,
    tx?: Parameters<AuditLogService['record']>[1],
  ): Promise<void> {
    const reasonByStatus: Record<Exclude<UserStatus, 'active'>, string> = {
      deleted: 'account_deleted',
      pending_verification: 'pending_verification',
      locked: 'account_locked',
      suspended: 'account_suspended',
    };

    await this.auditLogService.record(
      {
        userId,
        action: 'LOGIN_FAILED',
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        metadata: {
          provider: 'email_password',
          reason: reasonByStatus[status],
        },
      },
      tx,
    );
  }

  private throwForNonActiveLoginStatus(status: UserStatus): never {
    switch (status) {
      case 'pending_verification':
        throw new AuthDomainError({
          status: 403,
          code: 'EMAIL_NOT_VERIFIED',
          message: AUTH_MESSAGES.emailNotVerified,
        });
      case 'locked':
        throw new AuthDomainError({
          status: 403,
          code: 'ACCOUNT_LOCKED',
          message: AUTH_MESSAGES.accountLocked,
        });
      case 'suspended':
        throw new AuthDomainError({
          status: 403,
          code: 'ACCOUNT_SUSPENDED',
          message: AUTH_MESSAGES.accountSuspended,
        });
      case 'deleted':
      case 'active':
      default:
        throw new AuthDomainError({
          status: 401,
          code: 'INVALID_CREDENTIALS',
          message: AUTH_MESSAGES.invalidCredentials,
        });
    }
  }

  private async equalizeResponseDuration(
    startedAtMs: number,
    minDurationMs: number,
  ): Promise<void> {
    if (minDurationMs <= 0) {
      return;
    }
    const targetDurationMs = minDurationMs + randomInt(0, RESEND_TIMING_JITTER_MS + 1);
    const remainingMs = targetDurationMs - (Date.now() - startedAtMs);
    if (remainingMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, remainingMs);
      });
    }
  }

  private resolveAppUrl(): string {
    return this.appUrlOverride ?? getEnv().APP_URL;
  }

  private buildPasswordResetUrl(rawResetToken: string): string {
    const url = new URL('/reset-password', this.resolveAppUrl());
    url.searchParams.set('token', rawResetToken);
    return url.toString();
  }

  private async sendVerificationOtpEmail(
    toEmail: string,
    displayName: string,
    otpCode: string,
  ): Promise<void> {
    const template = buildVerificationOtpEmail({
      displayName,
      otpCode,
      expiresInMinutes: EMAIL_VERIFY_OTP_TTL_MINUTES,
    });

    try {
      await this.emailProvider.send({
        to: toEmail,
        subject: template.subject,
        html: template.html,
        text: template.text,
      });
    } catch (error) {
      if (error instanceof EmailDeliveryError) {
        throw new AuthDomainError({
          status: 503,
          code: 'INTERNAL_ERROR',
          message: AUTH_MESSAGES.emailDeliveryUnavailable,
          cause: error,
        });
      }
      throw error;
    }
  }

  private async sendPasswordResetLinkEmail(
    toEmail: string,
    displayName: string,
    resetUrl: string,
  ): Promise<void> {
    const template = buildPasswordResetLinkEmail({
      displayName,
      resetUrl,
      expiresInMinutes: PASSWORD_RESET_TOKEN_TTL_MINUTES,
    });

    try {
      await this.emailProvider.send({
        to: toEmail,
        subject: template.subject,
        html: template.html,
        text: template.text,
      });
    } catch (error) {
      if (error instanceof EmailDeliveryError) {
        throw new AuthDomainError({
          status: 503,
          code: 'INTERNAL_ERROR',
          message: AUTH_MESSAGES.emailDeliveryUnavailable,
          cause: error,
        });
      }
      throw error;
    }
  }

  private async sendPasswordChangeOtpEmail(
    toEmail: string,
    displayName: string,
    otpCode: string,
  ): Promise<void> {
    const template = buildPasswordChangeOtpEmail({
      displayName,
      otpCode,
      expiresInMinutes: PASSWORD_CHANGE_OTP_TTL_MINUTES,
    });

    try {
      await this.emailProvider.send({
        to: toEmail,
        subject: template.subject,
        html: template.html,
        text: template.text,
      });
    } catch (error) {
      if (error instanceof EmailDeliveryError) {
        throw new AuthDomainError({
          status: 503,
          code: 'INTERNAL_ERROR',
          message: AUTH_MESSAGES.emailDeliveryUnavailable,
          cause: error,
        });
      }
      throw error;
    }
  }

  /**
   * Gửi email cảnh báo bảo mật sau khi giao dịch đặt lại/đổi mật khẩu ĐÃ COMMIT thành công:
   * nếu dịch vụ SMTP tạm gián đoạn chỉ ghi log cảnh báo an toàn (không chứa dữ liệu nhạy cảm)
   * để không làm hỏng phản hồi HTTP hoặc làm mất cookie phiên mới vừa cấp cho thiết bị hiện tại.
   */
  private async sendPasswordAlertEmailSafe(
    kind: 'reset' | 'changed',
    data: {
      readonly toEmail: string;
      readonly displayName: string;
      readonly occurredAt: Date;
      readonly ipAddress: string | null;
      readonly deviceInfo: string;
    },
  ): Promise<void> {
    const templateData = {
      displayName: data.displayName,
      occurredAt: data.occurredAt,
      ipAddress: data.ipAddress,
      deviceInfo: data.deviceInfo,
      appUrl: this.resolveAppUrl(),
    };
    const template =
      kind === 'reset'
        ? buildPasswordResetAlertEmail(templateData)
        : buildPasswordChangedAlertEmail(templateData);

    try {
      await this.emailProvider.send({
        to: data.toEmail,
        subject: template.subject,
        html: template.html,
        text: template.text,
      });
    } catch (error) {
      logger.warn(
        {
          component: 'auth-service',
          event:
            kind === 'reset'
              ? 'password_reset_alert_email_failed'
              : 'password_changed_alert_email_failed',
          errorName: error instanceof Error ? error.name : 'Error',
        },
        'Không thể gửi email cảnh báo thay đổi mật khẩu sau khi giao dịch đã hoàn tất',
      );
    }
  }

  /**
   * Gửi email cảnh báo bảo mật khi tài khoản chạm mốc 50 lần sai liên tiếp và tự khóa `locked`.
   * Chạy sau khi DB transaction ĐÃ COMMIT theo cơ chế fail-safe để sự cố SMTP không làm hỏng phản hồi `401`
   * hay tạo kênh phân biệt trạng thái tài khoản cho kẻ tấn công.
   */
  private async sendAccountLockedAlertEmailSafe(data: {
    readonly toEmail: string;
    readonly displayName: string;
    readonly occurredAt: Date;
    readonly ipAddress: string | null;
    readonly deviceInfo: string;
    readonly failedAttempts: number;
  }): Promise<void> {
    const template = buildAccountLockedAlertEmail({
      displayName: data.displayName,
      occurredAt: data.occurredAt,
      ipAddress: data.ipAddress,
      deviceInfo: data.deviceInfo,
      failedAttempts: data.failedAttempts,
      appUrl: this.resolveAppUrl(),
    });

    try {
      await this.emailProvider.send({
        to: data.toEmail,
        subject: template.subject,
        html: template.html,
        text: template.text,
      });
    } catch (error) {
      logger.warn(
        {
          component: 'auth-service',
          event: 'account_locked_alert_email_failed',
          errorName: error instanceof Error ? error.name : 'Error',
        },
        'Không thể gửi email cảnh báo khóa tài khoản sau khi đã khóa thành công',
      );
    }
  }
}

export function createAuthService(deps: AuthServiceDependencies = {}): AuthService {
  return new AuthService(deps);
}

const globalForAuthService = globalThis as typeof globalThis & {
  __tomatoAuthService?: AuthService;
};

export function getAuthService(): AuthService {
  if (!globalForAuthService.__tomatoAuthService) {
    globalForAuthService.__tomatoAuthService = createAuthService();
  }
  return globalForAuthService.__tomatoAuthService;
}

export function setAuthServiceForTesting(service: AuthService): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('setAuthServiceForTesting chỉ được phép gọi trong môi trường test');
  }
  globalForAuthService.__tomatoAuthService = service;
}

export function resetAuthServiceForTesting(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetAuthServiceForTesting chỉ được phép gọi trong môi trường test');
  }
  globalForAuthService.__tomatoAuthService = undefined;
}
