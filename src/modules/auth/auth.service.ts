import 'server-only';

import { getCaptchaProvider, type CaptchaProvider } from '@/core/captcha';
import { getEnv } from '@/core/config/env';
import { generatePublicId, generateUuidV7 } from '@/core/crypto/id';
import { generateOtpCode, hashOtpCode, verifyOtpCode } from '@/core/crypto/otp';
import { hashPassword, verifyDummyPassword } from '@/core/crypto/password';
import { isPostgresUniqueViolation } from '@/core/db';
import {
  EmailDeliveryError,
  buildDuplicateRegistrationEmail,
  buildVerificationOtpEmail,
  getEmailProvider,
  type EmailProvider,
} from '@/core/email';
import { logger } from '@/core/logger';
import {
  AUTH_RATE_LIMITS,
  getRateLimiter,
  type RateLimitRule,
  type RateLimiter,
} from '@/core/redis';
import { getAuditLogService, type AuditLogService } from '@/core/security/audit-log.service';
import type { RequestClientContext } from '@/core/security/client-context';
import { formatZodErrorDetails } from '@/core/security/http-response';
import { AuthDomainError } from '@/modules/auth/auth.errors';
import { AUTH_MESSAGES } from '@/modules/auth/auth.messages';
import { AuthRepository, type IdentityWithUser } from '@/modules/auth/auth.repository';
import {
  createRegisterInputSchema,
  resendVerificationInputSchema,
  verifyEmailInputSchema,
} from '@/modules/auth/auth.schemas';

export const EMAIL_VERIFY_OTP_TTL_MINUTES = 15;
export const EMAIL_VERIFY_OTP_TTL_MS = EMAIL_VERIFY_OTP_TTL_MINUTES * 60 * 1000;
export const EMAIL_VERIFY_OTP_MAX_ATTEMPTS = 5;
export const RESEND_COOLDOWN_SECONDS = AUTH_RATE_LIMITS.resendVerificationCooldown.windowSeconds;
// Sau 24 giờ không xác minh, tài khoản pending_verification được phép đăng ký đè theo Mục 4.1.
export const PENDING_VERIFICATION_EXPIRY_MS = 24 * 60 * 60 * 1000;

// Chặn spam email nhắc nhở vào hộp thư của chủ tài khoản đã active khi bị tấn công từ nhiều IP.
const DUPLICATE_NOTICE_EMAIL_COOLDOWN: RateLimitRule = Object.freeze({
  limit: 1,
  windowSeconds: 15 * 60,
  strategy: 'fixed_window',
});

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

export interface AuthServiceDependencies {
  readonly repository?: AuthRepository;
  readonly rateLimiter?: RateLimiter;
  readonly emailProvider?: EmailProvider;
  readonly captchaProvider?: CaptchaProvider;
  readonly auditLogService?: AuditLogService;
  readonly appUrl?: string;
  readonly now?: () => Date;
}

type VerifyOtpTransactionOutcome =
  | { readonly kind: 'verified' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'max_attempts' }
  | { readonly kind: 'wrong_code'; readonly remainingAttempts: number };

/**
 * Tầng nghiệp vụ Auth cốt lõi (tách biệt hoàn toàn khỏi Next.js HTTP/cookies).
 */
export class AuthService {
  private readonly repository: AuthRepository;
  private readonly rateLimiter: RateLimiter;
  private readonly emailProvider: EmailProvider;
  private readonly captchaProvider: CaptchaProvider;
  private readonly auditLogService: AuditLogService;
  private readonly resolveAppUrl: () => string;
  private readonly now: () => Date;

  constructor(deps: AuthServiceDependencies = {}) {
    this.repository = deps.repository ?? new AuthRepository();
    this.rateLimiter = deps.rateLimiter ?? getRateLimiter();
    this.emailProvider = deps.emailProvider ?? getEmailProvider();
    this.captchaProvider = deps.captchaProvider ?? getCaptchaProvider();
    this.auditLogService = deps.auditLogService ?? getAuditLogService();
    this.resolveAppUrl = deps.appUrl ? () => deps.appUrl as string : () => getEnv().APP_URL;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Đăng ký tài khoản mới + phát hành OTP xác minh email (Mục 4.1).
   * - Luôn kiểm tra Rate Limit theo IP TRƯỚC khi validate nặng, gọi Turnstile, băm Argon2id hay truy vấn DB.
   * - Luôn trả cùng 1 phản hồi trung tính (không lộ `id`/`public_id` hay việc email đã tồn tại).
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

    // 4. Băm mật khẩu bằng Argon2id + Pepper ngoài transaction DB để không giữ kết nối PG trong lúc tính toán CPU.
    const { hash: passwordHash, pepperVersion } = await hashPassword(input.password);
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
            displayName: input.displayName,
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
      // Bắt race condition khi 2 request đăng ký trùng email chạy cùng 1 mili-giây (PostgreSQL 23505).
      if (isPostgresUniqueViolation(error)) {
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

    await this.sendVerificationOtpEmail(input.email, input.displayName, otpCode);

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

    const existing = await this.repository.findEmailIdentityWithUser(input.email);
    if (!existing || existing.user.status !== 'pending_verification') {
      throw new AuthDomainError({
        status: 400,
        code: 'TOKEN_INVALID',
        message: AUTH_MESSAGES.otpInvalidOrExpired,
      });
    }

    const currentTime = this.now();

    // Quan trọng: trả về kết quả phân nhánh thay vì throw bên trong transaction,
    // để việc tăng `attempt_count` hoặc đặt `consumed_at` khi nhập sai KHÔNG bị PostgreSQL ROLLBACK.
    const outcome = await this.repository
      .getDb()
      .transaction<VerifyOtpTransactionOutcome>(async (tx) => {
        const token = await this.repository.lockLatestUnconsumedEmailVerifyToken(
          existing.user.id,
          tx,
        );

        if (!token) {
          return { kind: 'invalid' };
        }

        if (token.expiresAt.getTime() <= currentTime.getTime()) {
          await this.repository.consumeVerificationToken(token.id, currentTime, tx);
          return { kind: 'expired' };
        }

        if (token.attemptCount >= EMAIL_VERIFY_OTP_MAX_ATTEMPTS) {
          await this.repository.consumeVerificationToken(token.id, currentTime, tx);
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
        throw new AuthDomainError({
          status: 400,
          code: 'TOKEN_EXPIRED',
          message: AUTH_MESSAGES.otpExpired,
        });
      case 'max_attempts':
        throw new AuthDomainError({
          status: 400,
          code: 'TOKEN_INVALID',
          message: AUTH_MESSAGES.otpRevokedMaxAttempts,
        });
      case 'wrong_code':
        throw new AuthDomainError({
          status: 400,
          code: 'TOKEN_INVALID',
          message: AUTH_MESSAGES.otpIncorrectWithRemaining(outcome.remainingAttempts),
        });
      case 'invalid':
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
   * - Phản hồi trung tính để không làm lộ email đã tồn tại hay đã active.
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

    const existing = await this.repository.findEmailIdentityWithUser(email);
    if (existing && existing.user.status === 'pending_verification') {
      const currentTime = this.now();
      const otpCode = generateOtpCode();
      const otpTokenHash = hashOtpCode(otpCode, {
        userId: existing.user.id,
        purpose: 'email_verify',
      });
      const otpExpiresAt = new Date(currentTime.getTime() + EMAIL_VERIFY_OTP_TTL_MS);

      await this.repository.getDb().transaction(async (tx) => {
        await this.repository.reissueEmailVerifyToken(
          {
            userId: existing.user.id,
            otpTokenHash,
            otpExpiresAt,
            now: currentTime,
          },
          tx,
        );
      });

      await this.sendVerificationOtpEmail(email, existing.user.displayName, otpCode);
    }

    return {
      message: AUTH_MESSAGES.resendAccepted,
      cooldownSeconds: RESEND_COOLDOWN_SECONDS,
    };
  }

  private async handleExistingAccountRegistration(
    existing: IdentityWithUser,
    input: {
      readonly email: string;
      readonly password: string;
      readonly displayName: string;
      readonly dateOfBirth: string;
    },
    context: RequestClientContext,
    currentTime: Date,
  ): Promise<void> {
    if (existing.user.status === 'pending_verification') {
      const ageMs = currentTime.getTime() - existing.user.updatedAt.getTime();

      if (ageMs >= PENDING_VERIFICATION_EXPIRY_MS) {
        // Tài khoản chưa xác minh đã quá hạn (>= 24 giờ): cho phép đăng ký đè sạch sẽ (Mục 4.1).
        const { hash: passwordHash, pepperVersion } = await hashPassword(input.password);
        const otpCode = generateOtpCode();
        const otpTokenHash = hashOtpCode(otpCode, {
          userId: existing.user.id,
          purpose: 'email_verify',
        });
        const otpExpiresAt = new Date(currentTime.getTime() + EMAIL_VERIFY_OTP_TTL_MS);

        await this.repository.getDb().transaction(async (tx) => {
          await this.repository.overwriteExpiredPendingUserWithOtp(
            {
              userId: existing.user.id,
              identityId: existing.identity.id,
              displayName: input.displayName,
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
        });

        await this.rateLimiter.consume(
          `resend:cooldown:${input.email}`,
          AUTH_RATE_LIMITS.resendVerificationCooldown,
        );
        await this.sendVerificationOtpEmail(input.email, input.displayName, otpCode);
        return;
      }

      // Tài khoản `pending_verification` còn trong hạn (< 24 giờ): TUYỆT ĐỐI không ghi đè mật khẩu
      // (chống pre-account takeover), chỉ cấp lại OTP mới (nếu hết cooldown) và vô hiệu hóa OTP cũ.
      await verifyDummyPassword();

      const cooldown = await this.rateLimiter.consume(
        `resend:cooldown:${input.email}`,
        AUTH_RATE_LIMITS.resendVerificationCooldown,
      );

      if (!cooldown.allowed) {
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

      await this.repository.getDb().transaction(async (tx) => {
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
      });

      await this.sendVerificationOtpEmail(input.email, existing.user.displayName, otpCode);
      return;
    }

    // Email thuộc tài khoản đã tồn tại (`active` / `locked` / `suspended` / `deleted`):
    // chạy `verifyDummyPassword()` để đồng bộ thời gian Argon2id, ngăn timing enumeration.
    await verifyDummyPassword();

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

    if (existing.user.status === 'active' || existing.user.status === 'locked') {
      await this.sendDuplicateNoticeWithCooldown(input.email, existing.user.displayName);
    }
  }

  private async handleConcurrentDuplicateRegistration(
    emailNormalized: string,
    context: RequestClientContext,
  ): Promise<void> {
    const winner = await this.repository.findEmailIdentityWithUser(emailNormalized);

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

    if (winner && (winner.user.status === 'active' || winner.user.status === 'locked')) {
      await this.sendDuplicateNoticeWithCooldown(emailNormalized, winner.user.displayName);
    }
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

  private async sendDuplicateNoticeWithCooldown(
    toEmail: string,
    displayName: string,
  ): Promise<void> {
    const noticeCooldown = await this.rateLimiter.consume(
      `register:dup-notice:${toEmail}`,
      DUPLICATE_NOTICE_EMAIL_COOLDOWN,
    );
    if (!noticeCooldown.allowed) {
      return;
    }

    const template = buildDuplicateRegistrationEmail({
      displayName,
      appUrl: this.resolveAppUrl(),
    });

    try {
      await this.emailProvider.send({
        to: toEmail,
        subject: template.subject,
        html: template.html,
        text: template.text,
      });
    } catch (error) {
      // Lỗi gửi email nhắc nhở không được phép làm lộ sự tồn tại tài khoản hay gây HTTP 500.
      const err = error as Error;
      logger.warn(
        {
          component: 'auth',
          action: 'duplicate_registration_notice',
          errorName: err.name ?? 'Error',
        },
        'Không gửi được email nhắc nhở đăng ký trùng',
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
