import 'server-only';

import { getCaptchaProvider, type CaptchaProvider } from '@/core/captcha';
import { generatePublicId, generateUuidV7 } from '@/core/crypto/id';
import { generateOtpCode, hashOtpCode, verifyOtpCode } from '@/core/crypto/otp';
import {
  EnvPepperSecretProvider,
  hashPassword,
  verifyDummyPassword,
  verifyPassword,
  type PepperSecretProvider,
} from '@/core/crypto/password';
import { isPostgresUniqueViolation } from '@/core/db';
import {
  EmailDeliveryError,
  buildVerificationOtpEmail,
  getEmailProvider,
  type EmailProvider,
} from '@/core/email';
import { AUTH_RATE_LIMITS, getRateLimiter, type RateLimiter } from '@/core/redis';
import { getAuditLogService, type AuditLogService } from '@/core/security/audit-log.service';
import type { RequestClientContext } from '@/core/security/client-context';
import { formatZodErrorDetails } from '@/core/security/http-response';
import { AuthDomainError } from '@/modules/auth/auth.errors';
import { AUTH_MESSAGES } from '@/modules/auth/auth.messages';
import { AuthRepository, type IdentityWithUser } from '@/modules/auth/auth.repository';
import {
  createRegisterInputSchema,
  loginInputSchema,
  resendVerificationInputSchema,
  verifyEmailInputSchema,
} from '@/modules/auth/auth.schemas';
import {
  SessionService,
  toPublicUserProfile,
  type IssuedSessionTokens,
  type PublicUserProfile,
} from '@/modules/auth/session.service';

export const EMAIL_VERIFY_OTP_TTL_MINUTES = 15;
export const EMAIL_VERIFY_OTP_TTL_MS = EMAIL_VERIFY_OTP_TTL_MINUTES * 60 * 1000;
export const EMAIL_VERIFY_OTP_MAX_ATTEMPTS = 5;
export const RESEND_COOLDOWN_SECONDS = AUTH_RATE_LIMITS.resendVerificationCooldown.windowSeconds;
// Sau 24 giờ không xác minh, tài khoản pending_verification được phép đăng ký đè theo Mục 4.1.
export const PENDING_VERIFICATION_EXPIRY_MS = 24 * 60 * 60 * 1000;

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

export interface AuthServiceDependencies {
  readonly repository?: AuthRepository;
  readonly sessionService?: SessionService;
  readonly rateLimiter?: RateLimiter;
  readonly emailProvider?: EmailProvider;
  readonly captchaProvider?: CaptchaProvider;
  readonly auditLogService?: AuditLogService;
  readonly pepperProvider?: PepperSecretProvider;
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
  private readonly sessionService: SessionService;
  private readonly rateLimiter: RateLimiter;
  private readonly emailProvider: EmailProvider;
  private readonly captchaProvider: CaptchaProvider;
  private readonly auditLogService: AuditLogService;
  private readonly pepperProvider: PepperSecretProvider;
  private readonly now: () => Date;

  constructor(deps: AuthServiceDependencies = {}) {
    this.repository = deps.repository ?? new AuthRepository();
    this.rateLimiter = deps.rateLimiter ?? getRateLimiter();
    this.emailProvider = deps.emailProvider ?? getEmailProvider();
    this.captchaProvider = deps.captchaProvider ?? getCaptchaProvider();
    this.auditLogService = deps.auditLogService ?? getAuditLogService();
    this.pepperProvider = deps.pepperProvider ?? new EnvPepperSecretProvider();
    this.now = deps.now ?? (() => new Date());
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

  /**
   * Đăng nhập bằng Email + Mật khẩu và khởi tạo phiên thiết bị mới (Mục 4.2 & Mục 6.1–6.2):
   * 1. Chạy Rate Limit IP (`10 lần / 15 phút`) TRƯỚC khi validate nặng, truy DB hoặc băm Argon2id.
   * 2. Nếu không tìm thấy identity -> vẫn chạy `verifyDummyPassword()` chống Timing Attack.
   * 3. Sai email và sai mật khẩu trả mã lỗi `401 INVALID_CREDENTIALS` & thông báo giống hệt nhau.
   * 4. Chỉ kiểm tra trạng thái tài khoản SAU khi xác minh đúng mật khẩu (chống dò trạng thái tài khoản).
   * 5. Nếu tài khoản `active` và cần rehash (Pepper/Argon2 cũ) -> tự động băm lại và lưu vào DB.
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

    // 3. Tra cứu danh tính theo email đã chuẩn hóa.
    const existing = await this.repository.findEmailIdentityWithUser(input.email);
    if (!existing || !existing.identity.passwordHash) {
      // Chạy Argon2id giả cùng chi phí để thời gian phản hồi đồng nhất dù email không tồn tại.
      await verifyDummyPassword();

      await this.auditLogService.record({
        userId: existing?.user.id ?? null,
        action: 'LOGIN_FAILED',
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        metadata: {
          provider: 'email_password',
          reason: 'identity_not_found',
        },
      });

      throw new AuthDomainError({
        status: 401,
        code: 'INVALID_CREDENTIALS',
        message: AUTH_MESSAGES.invalidCredentials,
      });
    }

    // 4. Đối chiếu mật khẩu qua Argon2id + Pepper đúng phiên bản.
    const verification = await verifyPassword(
      input.password,
      existing.identity.passwordHash,
      existing.identity.pepperVersion,
      this.pepperProvider,
    );

    if (!verification.valid) {
      await this.auditLogService.record({
        userId: existing.user.id,
        action: 'LOGIN_FAILED',
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        metadata: {
          provider: 'email_password',
          reason: 'invalid_password',
        },
      });

      throw new AuthDomainError({
        status: 401,
        code: 'INVALID_CREDENTIALS',
        message: AUTH_MESSAGES.invalidCredentials,
      });
    }

    // 5. Chỉ tiết lộ trạng thái tài khoản sau khi người gọi đã chứng minh biết đúng mật khẩu.
    switch (existing.user.status) {
      case 'deleted':
        await this.auditLogService.record({
          userId: existing.user.id,
          action: 'LOGIN_FAILED',
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          metadata: {
            provider: 'email_password',
            reason: 'account_deleted',
          },
        });
        throw new AuthDomainError({
          status: 401,
          code: 'INVALID_CREDENTIALS',
          message: AUTH_MESSAGES.invalidCredentials,
        });

      case 'pending_verification':
        await this.auditLogService.record({
          userId: existing.user.id,
          action: 'LOGIN_FAILED',
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          metadata: {
            provider: 'email_password',
            reason: 'pending_verification',
          },
        });
        throw new AuthDomainError({
          status: 403,
          code: 'EMAIL_NOT_VERIFIED',
          message: AUTH_MESSAGES.emailNotVerified,
        });

      case 'locked':
        await this.auditLogService.record({
          userId: existing.user.id,
          action: 'LOGIN_FAILED',
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          metadata: {
            provider: 'email_password',
            reason: 'account_locked',
          },
        });
        throw new AuthDomainError({
          status: 403,
          code: 'ACCOUNT_LOCKED',
          message: AUTH_MESSAGES.accountLocked,
        });

      case 'suspended':
        await this.auditLogService.record({
          userId: existing.user.id,
          action: 'LOGIN_FAILED',
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          metadata: {
            provider: 'email_password',
            reason: 'account_suspended',
          },
        });
        throw new AuthDomainError({
          status: 403,
          code: 'ACCOUNT_SUSPENDED',
          message: AUTH_MESSAGES.accountSuspended,
        });

      case 'active':
        break;
    }

    // 6. Nếu Pepper version hoặc tham số Argon2id đã cũ -> tính toán bản băm mới ngoài DB transaction.
    const rehashed = verification.needsRehash
      ? await hashPassword(input.password, this.pepperProvider)
      : null;

    const currentTime = this.now();

    const createdSession = await this.repository.getDb().transaction(async (tx) => {
      if (rehashed) {
        await this.repository.updateIdentityPasswordHash(
          {
            identityId: existing.identity.id,
            passwordHash: rehashed.hash,
            pepperVersion: rehashed.pepperVersion,
            now: currentTime,
          },
          tx,
        );
      }

      if (existing.identity.failedLoginAttempts > 0) {
        await this.repository.resetFailedLoginAttempts(existing.identity.id, currentTime, tx);
      }

      const issued = await this.sessionService.createSessionForUser(existing.user, context, tx);

      await this.auditLogService.record(
        {
          userId: existing.user.id,
          action: 'LOGIN_SUCCESS',
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          metadata: {
            provider: 'email_password',
            sessionPublicId: issued.session.publicId,
            deviceInfo: issued.session.deviceInfo,
            passwordRehashed: Boolean(rehashed),
          },
        },
        tx,
      );

      return issued;
    });

    return {
      user: toPublicUserProfile(existing.user),
      message: AUTH_MESSAGES.loginSuccess,
      tokens: createdSession.tokens,
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

    if (winner && winner.user.status !== 'pending_verification') {
      throw new AuthDomainError({
        status: 409,
        code: 'CONFLICT',
        message: AUTH_MESSAGES.emailAlreadyExists,
        details: [{ field: 'email', message: AUTH_MESSAGES.emailAlreadyExists }],
      });
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
