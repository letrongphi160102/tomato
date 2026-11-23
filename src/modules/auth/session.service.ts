import 'server-only';

import { generatePublicId, generateUuidV7 } from '@/core/crypto/id';
import {
  AccessTokenVerificationError,
  signAccessToken,
  verifyAccessToken,
} from '@/core/crypto/jwt';
import { generateSecureToken, hashTokenSha256 } from '@/core/crypto/token';
import type { DatabaseTransaction } from '@/core/db';
import type { SessionRow, UserGender, UserRow, UserStatus } from '@/core/db/schema';
import { AUTH_RATE_LIMITS, getRateLimiter, type RateLimiter } from '@/core/redis';
import { getAuditLogService, type AuditLogService } from '@/core/security/audit-log.service';
import type { RequestClientContext } from '@/core/security/client-context';
import { formatZodErrorDetails } from '@/core/security/http-response';
import { AuthDomainError } from '@/modules/auth/auth.errors';
import { AUTH_MESSAGES } from '@/modules/auth/auth.messages';
import {
  assertCanAccessUserSessions,
  assertCanRevokeSession,
  assertCanRevokeUserSessions,
  type AuthenticatedPrincipal,
} from '@/modules/auth/auth.policy';
import { AuthRepository } from '@/modules/auth/auth.repository';
import {
  revokeAllSessionsInputSchema,
  sessionPublicIdParamSchema,
} from '@/modules/auth/auth.schemas';
import { UNKNOWN_DEVICE_LABEL, parseDeviceInfo } from '@/modules/auth/device-info';

export const SESSION_ABSOLUTE_TTL_DAYS = 30;
export const SESSION_ABSOLUTE_TTL_MS = SESSION_ABSOLUTE_TTL_DAYS * 24 * 60 * 60 * 1000;
export const SESSION_IDLE_TTL_DAYS = 14;
export const SESSION_IDLE_TTL_MS = SESSION_IDLE_TTL_DAYS * 24 * 60 * 60 * 1000;
/** Thiết bị khác có hoạt động trong 15 phút gần đây được phân loại là "Đang hoạt động" (Online). */
export const SESSION_ONLINE_THRESHOLD_MS = 15 * 60 * 1000;
/** Tiết lưu cập nhật `last_used_at` tối đa 5 phút/lần trên API đọc để tối ưu chi phí ghi Neon Free. */
export const SESSION_LAST_USED_TOUCH_INTERVAL_MS = 5 * 60 * 1000;
/** Giới hạn số thiết bị/lịch sử đăng nhập gần nhất trả về cho trang quản lý thiết bị. */
export const SESSION_LIST_MAX_ITEMS = 25;
// Địa chỉ IPv4 chưa xác định theo RFC 1122 dùng cho cột `sessions.ip_address INET NOT NULL`
// khi request chạy cục bộ không đi qua reverse proxy gắn header IP.
export const FALLBACK_SESSION_IP_ADDRESS = '0.0.0.0';

const MIN_OPAQUE_REFRESH_TOKEN_LENGTH = 32;

export interface PublicUserProfile {
  readonly public_id: string;
  readonly username: string;
  readonly fullName: string;
  readonly gender: UserGender;
  readonly status: UserStatus;
}

export interface IssuedSessionTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly csrfToken: string;
}

export interface CreatedSessionResult {
  readonly session: SessionRow;
  readonly tokens: IssuedSessionTokens;
}

export interface RefreshSessionResult {
  readonly refreshed: true;
  readonly user: PublicUserProfile;
  readonly expiresAt: Date;
  readonly tokens: {
    readonly accessToken: string;
    readonly refreshToken: string;
  };
}

export interface LogoutSessionResult {
  readonly loggedOut: true;
  readonly message: string;
}

export type SessionActivityStatus = 'online' | 'offline';
export type SessionHistoryStatus = 'logged_out' | 'expired';

export interface PublicSessionItem {
  readonly public_id: string;
  readonly deviceInfo: string;
  readonly ipAddress: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly expiresAt: string;
  readonly isCurrent: boolean;
  readonly activityStatus: SessionActivityStatus;
}

export interface PublicSessionHistoryItem {
  readonly public_id: string;
  readonly deviceInfo: string;
  readonly ipAddress: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly endedAt: string;
  readonly historyStatus: SessionHistoryStatus;
}

export interface ListSessionsResult {
  readonly sessions: readonly PublicSessionItem[];
  readonly history: readonly PublicSessionHistoryItem[];
}

export interface RevokeSessionResult {
  readonly revoked: true;
  readonly sessionPublicId: string;
  readonly revokedCurrent: boolean;
  readonly message: string;
}

export interface RevokeAllSessionsResult {
  readonly revokedCount: number;
  readonly includeCurrent: boolean;
  readonly message: string;
}

export interface SessionServiceDependencies {
  readonly repository?: AuthRepository;
  readonly rateLimiter?: RateLimiter;
  readonly auditLogService?: AuditLogService;
  readonly now?: () => Date;
}

type RefreshTransactionOutcome =
  | {
      readonly kind: 'rotated';
      readonly user: UserRow;
      readonly newSessionPublicId: string;
      readonly newRefreshToken: string;
      readonly expiresAt: Date;
    }
  | { readonly kind: 'reuse_detected' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'revoked' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'idle_expired' }
  | { readonly kind: 'inactive_user' };

type RevokeSessionTransactionOutcome = 'revoked' | 'not_found' | 'unauthorized';

type RevokeAllSessionsTransactionOutcome =
  { readonly kind: 'revoked'; readonly count: number } | { readonly kind: 'unauthorized' };

/**
 * Kiểm tra thống nhất một bản ghi phiên có còn đang hoạt động hợp lệ (chưa thu hồi,
 * chưa quá hạn tuyệt đối 30 ngày và chưa quá hạn không hoạt động 14 ngày) hay không.
 */
export function isSessionCurrentlyActive(
  session: Pick<SessionRow, 'revokedAt' | 'expiresAt' | 'lastUsedAt'>,
  now: Date,
  idleTtlMs: number = SESSION_IDLE_TTL_MS,
): boolean {
  const nowMs = now.getTime();
  return (
    session.revokedAt === null &&
    session.expiresAt.getTime() > nowMs &&
    nowMs - session.lastUsedAt.getTime() <= idleTtlMs
  );
}

export function toPublicUserProfile(user: UserRow): PublicUserProfile {
  return {
    public_id: user.publicId,
    username: user.username,
    fullName: user.fullName,
    gender: user.gender,
    status: user.status,
  };
}

/**
 * Phân loại tập bản ghi đại diện theo từng `family_id` thành:
 * - `sessions`: thiết bị đang có phiên hợp lệ (thiết bị hiện tại lên đầu; phân biệt `online` <= 15p vs `offline` > 15p).
 * - `history`: lịch sử thiết bị đã đăng xuất (`logged_out`) hoặc hết hạn (`expired`).
 * Không bao giờ trả về khóa nội bộ `id`, `userId`, `familyId` hay `refreshTokenHash`.
 */
export function classifyDeviceSessions(
  rows: readonly SessionRow[],
  options: {
    readonly currentSessionPublicId: string;
    readonly now: Date;
    readonly idleTtlMs?: number;
    readonly onlineThresholdMs?: number;
  },
): ListSessionsResult {
  const nowMs = options.now.getTime();
  const idleTtlMs = options.idleTtlMs ?? SESSION_IDLE_TTL_MS;
  const onlineThresholdMs = options.onlineThresholdMs ?? SESSION_ONLINE_THRESHOLD_MS;

  const activeItems: PublicSessionItem[] = [];
  const historyItems: PublicSessionHistoryItem[] = [];

  for (const row of rows) {
    const isRevoked = row.revokedAt !== null;
    const isAbsoluteExpired = row.expiresAt.getTime() <= nowMs;
    const isIdleExpired = nowMs - row.lastUsedAt.getTime() > idleTtlMs;

    if (!isRevoked && !isAbsoluteExpired && !isIdleExpired) {
      const isCurrent = row.publicId === options.currentSessionPublicId;
      const isOnline = isCurrent || nowMs - row.lastUsedAt.getTime() <= onlineThresholdMs;

      activeItems.push({
        public_id: row.publicId,
        deviceInfo: row.deviceInfo ?? UNKNOWN_DEVICE_LABEL,
        ipAddress: row.ipAddress,
        createdAt: row.createdAt.toISOString(),
        lastUsedAt: row.lastUsedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        isCurrent,
        activityStatus: isOnline ? 'online' : 'offline',
      });
      continue;
    }

    const expiredReason =
      !isRevoked || row.revokeReason === 'expired' || row.revokeReason === 'idle_timeout';
    const endedAtMs = row.revokedAt
      ? row.revokedAt.getTime()
      : Math.min(row.expiresAt.getTime(), row.lastUsedAt.getTime() + idleTtlMs);

    historyItems.push({
      public_id: row.publicId,
      deviceInfo: row.deviceInfo ?? UNKNOWN_DEVICE_LABEL,
      ipAddress: row.ipAddress,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt.toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
      historyStatus: expiredReason ? 'expired' : 'logged_out',
    });
  }

  activeItems.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) {
      return a.isCurrent ? -1 : 1;
    }
    return b.lastUsedAt.localeCompare(a.lastUsedAt);
  });

  historyItems.sort((a, b) => b.endedAt.localeCompare(a.endedAt));

  return {
    sessions: activeItems,
    history: historyItems,
  };
}

/**
 * Tầng nghiệp vụ Quản lý Phiên & Thiết bị (tách biệt hoàn toàn khỏi Next.js HTTP/Cookies).
 * - Quản lý vòng đời Access Token (15p), Refresh Token (>=256-bit, SHA-256, family_id),
 *   xoay vòng nguyên tử trong DB Transaction, phát hiện tái sử dụng (Reuse Detection),
 *   hạn tuyệt đối 30 ngày, hạn không hoạt động 14 ngày và phân quyền chống IDOR qua `auth.policy.ts`.
 */
export class SessionService {
  private readonly repository: AuthRepository;
  private readonly rateLimiter: RateLimiter;
  private readonly auditLogService: AuditLogService;
  private readonly now: () => Date;

  constructor(deps: SessionServiceDependencies = {}) {
    this.repository = deps.repository ?? new AuthRepository();
    this.rateLimiter = deps.rateLimiter ?? getRateLimiter();
    this.auditLogService = deps.auditLogService ?? getAuditLogService();
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Khởi tạo phiên mới cho thiết bị đăng nhập:
   * sinh UUIDv7 nội bộ, `public_id` công khai, `family_id`, Refresh Token >= 256-bit (chỉ lưu SHA-256),
   * Access Token JWT 15 phút (`sub`, `sid`) và CSRF Token 256-bit mới chống CSRF fixation.
   */
  async createSessionForUser(
    user: UserRow,
    context: RequestClientContext,
    tx?: DatabaseTransaction,
  ): Promise<CreatedSessionResult> {
    const currentTime = this.now();
    const sessionId = generateUuidV7();
    const sessionPublicId = generatePublicId();
    const familyId = generatePublicId();
    const refreshToken = generateSecureToken(32);
    const refreshTokenHash = hashTokenSha256(refreshToken);
    const csrfToken = generateSecureToken(32);
    const deviceInfo = parseDeviceInfo(context.userAgent);
    const ipAddress = context.ipAddress ?? FALLBACK_SESSION_IP_ADDRESS;
    const expiresAt = new Date(currentTime.getTime() + SESSION_ABSOLUTE_TTL_MS);

    const session = await this.repository.createSession(
      {
        id: sessionId,
        publicId: sessionPublicId,
        userId: user.id,
        familyId,
        refreshTokenHash,
        deviceInfo,
        ipAddress,
        lastUsedAt: currentTime,
        expiresAt,
        createdAt: currentTime,
      },
      tx ?? this.repository.getDb(),
    );

    const accessToken = await signAccessToken(
      {
        userPublicId: user.publicId,
        sessionPublicId: session.publicId,
      },
      {
        nowSeconds: Math.floor(currentTime.getTime() / 1000),
      },
    );

    return {
      session,
      tokens: {
        accessToken,
        refreshToken,
        csrfToken,
      },
    };
  }

  /**
   * Xác thực Access Token JWT và đối chiếu đồng bộ phiên/tài khoản trong PostgreSQL
   * để đảm bảo thao tác đăng xuất / thu hồi thiết bị có hiệu lực ngay lập tức trên mọi API Auth.
   */
  async authenticateAccessToken(accessToken: string | null): Promise<AuthenticatedPrincipal> {
    if (!accessToken || accessToken.trim().length === 0) {
      throw new AuthDomainError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: AUTH_MESSAGES.unauthorized,
      });
    }

    const currentTime = this.now();
    let claims;
    try {
      claims = await verifyAccessToken(accessToken, { currentDate: currentTime });
    } catch (error) {
      if (error instanceof AccessTokenVerificationError) {
        throw new AuthDomainError({
          status: 401,
          code: 'UNAUTHORIZED',
          message: AUTH_MESSAGES.unauthorized,
        });
      }
      throw error;
    }

    const match = await this.repository.findSessionWithUserByPublicId(claims.sid);
    if (!match) {
      throw new AuthDomainError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: AUTH_MESSAGES.unauthorized,
      });
    }

    const { session, user } = match;
    const isAbsoluteExpired = session.expiresAt.getTime() <= currentTime.getTime();
    const isIdleExpired =
      currentTime.getTime() - session.lastUsedAt.getTime() > SESSION_IDLE_TTL_MS;

    if (
      user.publicId !== claims.sub ||
      user.status !== 'active' ||
      session.revokedAt !== null ||
      isAbsoluteExpired ||
      isIdleExpired
    ) {
      throw new AuthDomainError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: AUTH_MESSAGES.unauthorized,
      });
    }

    // Tiết lưu cập nhật `last_used_at` (tối đa 5 phút/lần) để hiển thị trạng thái Online/Offline
    // sát thực tế mà không gây tải ghi liên tục lên PostgreSQL Serverless (Neon Free).
    let effectiveSession = session;
    if (
      currentTime.getTime() - session.lastUsedAt.getTime() >= SESSION_LAST_USED_TOUCH_INTERVAL_MS &&
      typeof this.repository.touchSessionLastUsedAt === 'function'
    ) {
      await this.repository
        .touchSessionLastUsedAt(session.id, user.id, currentTime)
        .catch(() => undefined);
      effectiveSession = { ...session, lastUsedAt: currentTime };
    }

    return { user, session: effectiveSession };
  }

  /**
   * Xoay vòng Refresh Token nguyên tử trong DB Transaction kèm Reuse Detection (Mục 6.2):
   * - Nếu phát hiện Refresh Token cũ đã từng bị xoay vòng (`token_rotated` / `token_reuse`)
   *   -> thu hồi TOÀN BỘ phiên còn sống cùng `family_id`, ghi Audit Log `TOKEN_REUSE_DETECTED`,
   *   yêu cầu Route Handler xóa cookie và trả `401`.
   * - Kiểm tra cả hạn tuyệt đối (30 ngày) và hạn không hoạt động (14 ngày).
   */
  async refreshSession(
    refreshToken: string | null,
    context: RequestClientContext,
  ): Promise<RefreshSessionResult> {
    const ipLimit = await this.rateLimiter.consume(
      `refresh:ip:${context.rateLimitIpKey}`,
      AUTH_RATE_LIMITS.refreshByIp,
    );
    if (!ipLimit.allowed) {
      throw new AuthDomainError({
        status: 429,
        code: 'RATE_LIMITED',
        message: AUTH_MESSAGES.rateLimited(ipLimit.retryAfterSeconds),
        retryAfterSeconds: ipLimit.retryAfterSeconds,
      });
    }

    if (!refreshToken || refreshToken.trim().length < MIN_OPAQUE_REFRESH_TOKEN_LENGTH) {
      throw new AuthDomainError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: AUTH_MESSAGES.unauthorized,
        clearCookies: true,
      });
    }

    const currentTime = this.now();
    const tokenHash = hashTokenSha256(refreshToken);

    // Quan trọng: trả về kết quả phân nhánh thay vì throw bên trong transaction,
    // để lệnh thu hồi toàn bộ `family_id` và bản ghi `TOKEN_REUSE_DETECTED` LUÔN được COMMIT.
    const outcome = await this.repository
      .getDb()
      .transaction<RefreshTransactionOutcome>(async (tx) => {
        const session = await this.repository.lockSessionByRefreshTokenHash(tokenHash, tx);
        if (!session) {
          return { kind: 'invalid' };
        }

        if (session.revokedAt !== null) {
          if (session.revokeReason === 'token_rotated' || session.revokeReason === 'token_reuse') {
            const revokedIds = await this.repository.revokeSessionFamily(
              session.familyId,
              session.userId,
              currentTime,
              'token_reuse',
              tx,
            );

            await this.auditLogService.record(
              {
                userId: session.userId,
                action: 'TOKEN_REUSE_DETECTED',
                ipAddress: context.ipAddress,
                userAgent: context.userAgent,
                metadata: {
                  familyId: session.familyId,
                  reusedSessionPublicId: session.publicId,
                  revokedActiveSessionsCount: revokedIds.length,
                },
              },
              tx,
            );

            return { kind: 'reuse_detected' };
          }

          return { kind: 'revoked' };
        }

        if (session.expiresAt.getTime() <= currentTime.getTime()) {
          await this.repository.revokeSessionById(
            session.id,
            session.userId,
            currentTime,
            'expired',
            tx,
          );
          return { kind: 'expired' };
        }

        if (currentTime.getTime() - session.lastUsedAt.getTime() > SESSION_IDLE_TTL_MS) {
          await this.repository.revokeSessionById(
            session.id,
            session.userId,
            currentTime,
            'idle_timeout',
            tx,
          );
          return { kind: 'idle_expired' };
        }

        const user = await this.repository.findUserById(session.userId, tx);
        if (!user || user.status !== 'active') {
          await this.repository.revokeSessionById(
            session.id,
            session.userId,
            currentTime,
            'account_inactive',
            tx,
          );
          return { kind: 'inactive_user' };
        }

        const newSessionId = generateUuidV7();
        const newSessionPublicId = generatePublicId();
        const newRefreshToken = generateSecureToken(32);
        const newRefreshTokenHash = hashTokenSha256(newRefreshToken);
        const deviceInfo = context.userAgent
          ? parseDeviceInfo(context.userAgent)
          : (session.deviceInfo ?? UNKNOWN_DEVICE_LABEL);
        const ipAddress = context.ipAddress ?? session.ipAddress;

        const rotatedSession = await this.repository.rotateSessionInFamily(
          {
            previousSessionId: session.id,
            rotatedAt: currentTime,
            newSession: {
              id: newSessionId,
              publicId: newSessionPublicId,
              userId: session.userId,
              familyId: session.familyId,
              refreshTokenHash: newRefreshTokenHash,
              deviceInfo,
              ipAddress,
              lastUsedAt: currentTime,
              // Giữ nguyên mốc đăng nhập ban đầu và hạn tuyệt đối 30 ngày của chuỗi phiên.
              expiresAt: session.expiresAt,
              createdAt: session.createdAt,
            },
          },
          tx,
        );

        if (!rotatedSession) {
          return { kind: 'revoked' };
        }

        return {
          kind: 'rotated',
          user,
          newSessionPublicId: rotatedSession.publicId,
          newRefreshToken,
          expiresAt: rotatedSession.expiresAt,
        };
      });

    if (outcome.kind !== 'rotated') {
      throw new AuthDomainError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: AUTH_MESSAGES.unauthorized,
        clearCookies: true,
      });
    }

    const accessToken = await signAccessToken(
      {
        userPublicId: outcome.user.publicId,
        sessionPublicId: outcome.newSessionPublicId,
      },
      {
        nowSeconds: Math.floor(currentTime.getTime() / 1000),
      },
    );

    return {
      refreshed: true,
      user: toPublicUserProfile(outcome.user),
      expiresAt: outcome.expiresAt,
      tokens: {
        accessToken,
        refreshToken: outcome.newRefreshToken,
      },
    };
  }

  /**
   * Đăng xuất thiết bị hiện tại: thu hồi phiên trong DB (hỗ trợ cả khi Access Token đã hết hạn
   * bằng cách dự phòng tra cứu Refresh Token đang hoạt động) và ghi Audit Log `SESSION_REVOKED`.
   */
  async logoutCurrentSession(
    tokens: { readonly accessToken: string | null; readonly refreshToken: string | null },
    context: RequestClientContext,
  ): Promise<LogoutSessionResult> {
    const currentTime = this.now();
    let targetSession: SessionRow | null = null;

    if (tokens.accessToken && tokens.accessToken.trim().length > 0) {
      try {
        const claims = await verifyAccessToken(tokens.accessToken, { currentDate: currentTime });
        const match = await this.repository.findSessionWithUserByPublicId(claims.sid);
        // Chấp nhận cả phiên vừa xoay vòng (`token_rotated`) để triệt tiêu race condition
        // khi 1 tab vừa chạy Silent Refresh `S1 -> S2` ngay trước lúc tab khác bấm Đăng xuất bằng AT1.
        if (
          match &&
          match.user.publicId === claims.sub &&
          (match.session.revokedAt === null || match.session.revokeReason === 'token_rotated')
        ) {
          targetSession = match.session;
        }
      } catch {
        // Access Token có thể đã hết hạn sau 15 phút; rơi sang kiểm tra Refresh Token bên dưới.
      }
    }

    if (
      !targetSession &&
      tokens.refreshToken &&
      tokens.refreshToken.trim().length >= MIN_OPAQUE_REFRESH_TOKEN_LENGTH
    ) {
      const candidate = await this.repository.findSessionByRefreshTokenHash(
        hashTokenSha256(tokens.refreshToken),
      );
      if (
        candidate &&
        (candidate.revokedAt === null || candidate.revokeReason === 'token_rotated')
      ) {
        targetSession = candidate;
      }
    }

    if (targetSession) {
      const sessionToRevoke = targetSession;
      await this.repository.getDb().transaction(async (tx) => {
        // Tuân thủ thứ tự khóa chuẩn (`users FOR SHARE` -> `advisory(familyId)` -> `sessions`)
        // và thu hồi toàn bộ chuỗi `family_id` của thiết bị hiện tại để triệt tiêu race condition
        // khi `/refresh` vừa xoay vòng `RT1 -> RT2` song song trong cùng mili-giây với `/logout`.
        await this.repository.lockUserById(sessionToRevoke.userId, tx, 'share');
        await this.repository.acquireSessionFamilyLock(sessionToRevoke.familyId, tx);
        const revokedIds = await this.repository.revokeSessionFamily(
          sessionToRevoke.familyId,
          sessionToRevoke.userId,
          currentTime,
          'user_logout',
          tx,
        );

        if (revokedIds.length > 0) {
          await this.auditLogService.record(
            {
              userId: sessionToRevoke.userId,
              action: 'SESSION_REVOKED',
              ipAddress: context.ipAddress,
              userAgent: context.userAgent,
              metadata: {
                scope: 'current_session',
                sessionPublicId: sessionToRevoke.publicId,
                revokedSessionsCount: revokedIds.length,
                reason: 'user_logout',
              },
            },
            tx,
          );
        }
      });
    }

    return {
      loggedOut: true,
      message: AUTH_MESSAGES.logoutSuccess,
    };
  }

  getCurrentUser(principal: AuthenticatedPrincipal): PublicUserProfile {
    return toPublicUserProfile(principal.user);
  }

  async listActiveSessions(principal: AuthenticatedPrincipal): Promise<ListSessionsResult> {
    assertCanAccessUserSessions(principal, principal.user.id);

    const currentTime = this.now();
    const idleCutoff = new Date(currentTime.getTime() - SESSION_IDLE_TTL_MS);

    const rows =
      typeof this.repository.listLatestSessionsPerFamilyByUserId === 'function'
        ? await this.repository.listLatestSessionsPerFamilyByUserId(
            principal.user.id,
            SESSION_LIST_MAX_ITEMS,
          )
        : await this.repository.listActiveSessionsByUserId(
            principal.user.id,
            currentTime,
            idleCutoff,
          );

    return classifyDeviceSessions(rows, {
      currentSessionPublicId: principal.session.publicId,
      now: currentTime,
      idleTtlMs: SESSION_IDLE_TTL_MS,
      onlineThresholdMs: SESSION_ONLINE_THRESHOLD_MS,
    });
  }

  /**
   * Thu hồi 1 thiết bị cụ thể theo `session.public_id`.
   * Bắt buộc kiểm tra chủ sở hữu qua `assertCanRevokeSession` (Deny by default -> 404 nếu sai chủ).
   */
  async revokeSession(
    principal: AuthenticatedPrincipal,
    rawSessionPublicId: string,
    context: RequestClientContext,
  ): Promise<RevokeSessionResult> {
    const parsedId = sessionPublicIdParamSchema.safeParse(rawSessionPublicId);
    if (!parsedId.success) {
      throw new AuthDomainError({
        status: 404,
        code: 'NOT_FOUND',
        message: AUTH_MESSAGES.sessionNotFound,
      });
    }

    // Phòng thủ chiều sâu chống IDOR: lọc chủ sở hữu `user_id` ngay tại tầng SQL,
    // đồng thời tiếp tục kiểm tra tập trung qua `auth.policy.ts` (Deny by default).
    const targetSession = await this.repository.findSessionByPublicIdForUser(
      parsedId.data,
      principal.user.id,
    );
    assertCanRevokeSession(principal, targetSession);

    const currentTime = this.now();
    if (!isSessionCurrentlyActive(targetSession, currentTime)) {
      throw new AuthDomainError({
        status: 404,
        code: 'NOT_FOUND',
        message: AUTH_MESSAGES.sessionNotFound,
      });
    }

    const revokedCurrent = targetSession.familyId === principal.session.familyId;

    const txOutcome = await this.repository
      .getDb()
      .transaction<RevokeSessionTransactionOutcome>(async (tx) => {
        // Tuân thủ thứ tự khóa toàn cục (`users FOR SHARE` -> `advisory(familyId)` -> `sessions`)
        // và tái kiểm tra trạng thái user/phiên hiện tại/phiên mục tiêu trong transaction chống TOCTOU.
        const lockedUser = await this.repository.lockUserById(principal.user.id, tx, 'share');
        if (!lockedUser || lockedUser.status !== 'active') {
          return 'unauthorized';
        }

        await this.repository.acquireSessionFamilyLock(targetSession.familyId, tx);

        const currentSession = await this.repository.findSessionByPublicIdForUser(
          principal.session.publicId,
          lockedUser.id,
          tx,
        );
        if (!currentSession || !isSessionCurrentlyActive(currentSession, currentTime)) {
          return 'unauthorized';
        }

        const freshTarget = await this.repository.findSessionByPublicIdForUser(
          targetSession.publicId,
          lockedUser.id,
          tx,
        );
        if (!freshTarget || !isSessionCurrentlyActive(freshTarget, currentTime)) {
          return 'not_found';
        }

        const revokedIds = await this.repository.revokeSessionFamily(
          freshTarget.familyId,
          lockedUser.id,
          currentTime,
          'session_revoked',
          tx,
        );
        if (revokedIds.length === 0) {
          return 'not_found';
        }

        await this.auditLogService.record(
          {
            userId: lockedUser.id,
            action: 'SESSION_REVOKED',
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            metadata: {
              scope: 'single_session',
              targetSessionPublicId: freshTarget.publicId,
              revokedCurrent,
            },
          },
          tx,
        );

        return 'revoked';
      });

    if (txOutcome === 'unauthorized') {
      throw new AuthDomainError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: AUTH_MESSAGES.unauthorized,
      });
    }

    if (txOutcome === 'not_found') {
      throw new AuthDomainError({
        status: 404,
        code: 'NOT_FOUND',
        message: AUTH_MESSAGES.sessionNotFound,
      });
    }

    return {
      revoked: true,
      sessionPublicId: targetSession.publicId,
      revokedCurrent,
      message: AUTH_MESSAGES.sessionRevoked,
    };
  }

  /**
   * Đăng xuất đồng loạt tất cả thiết bị khác (mặc định `includeCurrent: false`) hoặc toàn bộ thiết bị.
   * Bắt buộc kiểm tra qua `auth.policy.ts` và tái xác minh trạng thái tài khoản/phiên trong transaction.
   */
  async revokeAllSessions(
    principal: AuthenticatedPrincipal,
    rawInput: unknown,
    context: RequestClientContext,
  ): Promise<RevokeAllSessionsResult> {
    assertCanRevokeUserSessions(principal, principal.user.id);

    const parsed = revokeAllSessionsInputSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new AuthDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: AUTH_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }

    const { includeCurrent } = parsed.data;
    const currentTime = this.now();

    const txOutcome = await this.repository
      .getDb()
      .transaction<RevokeAllSessionsTransactionOutcome>(async (tx) => {
        // Khóa `users FOR UPDATE` và xác minh lại tài khoản + phiên hiện tại trước khi thu hồi hàng loạt
        // nhằm chặn TOCTOU nếu phiên gọi vừa bị thu hồi hoặc tài khoản vừa bị khóa/đình chỉ song song.
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

        const count = await this.repository.revokeAllUserSessions(
          {
            userId: lockedUser.id,
            excludeSessionId: includeCurrent ? undefined : currentSession.id,
            excludeFamilyId: includeCurrent ? undefined : currentSession.familyId,
            revokedAt: currentTime,
            reason: includeCurrent ? 'revoke_all_sessions' : 'revoke_other_sessions',
          },
          tx,
        );

        await this.auditLogService.record(
          {
            userId: lockedUser.id,
            action: 'SESSION_REVOKED',
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            metadata: {
              scope: includeCurrent ? 'all_sessions' : 'other_sessions',
              revokedCount: count,
              currentSessionPublicId: currentSession.publicId,
            },
          },
          tx,
        );

        return { kind: 'revoked', count };
      });

    if (txOutcome.kind === 'unauthorized') {
      throw new AuthDomainError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: AUTH_MESSAGES.unauthorized,
      });
    }

    return {
      revokedCount: txOutcome.count,
      includeCurrent,
      message: includeCurrent
        ? AUTH_MESSAGES.allSessionsRevoked
        : AUTH_MESSAGES.allOtherSessionsRevoked,
    };
  }
}

export function createSessionService(deps: SessionServiceDependencies = {}): SessionService {
  return new SessionService(deps);
}

const globalForSessionService = globalThis as typeof globalThis & {
  __tomatoSessionService?: SessionService;
};

export function getSessionService(): SessionService {
  if (!globalForSessionService.__tomatoSessionService) {
    globalForSessionService.__tomatoSessionService = createSessionService();
  }
  return globalForSessionService.__tomatoSessionService;
}

export function setSessionServiceForTesting(service: SessionService): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('setSessionServiceForTesting chỉ được phép gọi trong môi trường test');
  }
  globalForSessionService.__tomatoSessionService = service;
}

export function resetSessionServiceForTesting(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetSessionServiceForTesting chỉ được phép gọi trong môi trường test');
  }
  globalForSessionService.__tomatoSessionService = undefined;
}
