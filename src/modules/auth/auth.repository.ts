import 'server-only';

import { and, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';

import { generateUuidV7 } from '@/core/crypto/id';
import { getDb, type Database, type DatabaseTransaction, type DbExecutor } from '@/core/db';
import {
  authIdentities,
  sessions,
  users,
  verificationTokens,
  type AuthIdentityRow,
  type SessionRow,
  type UserGender,
  type UserRow,
  type UserStatus,
  type VerificationTokenPurpose,
  type VerificationTokenRow,
} from '@/core/db/schema';

export interface IdentityWithUser {
  readonly user: UserRow;
  readonly identity: AuthIdentityRow;
}

export interface SessionWithUser {
  readonly session: SessionRow;
  readonly user: UserRow;
}

export interface CreatePendingUserParams {
  readonly userId: string;
  readonly publicId: string;
  readonly identityId: string;
  readonly emailNormalized: string;
  readonly username: string;
  readonly fullName: string;
  readonly gender: UserGender;
  readonly dateOfBirth: string;
  readonly passwordHash: string;
  readonly pepperVersion: number;
  readonly otpTokenHash: string;
  readonly otpExpiresAt: Date;
  readonly now: Date;
}

export type OverwritePendingUserOutcome =
  'overwritten' | 'not_pending' | 'not_expired' | 'not_found';

export interface OverwriteExpiredPendingUserParams {
  readonly userId: string;
  readonly identityId: string;
  readonly username: string;
  readonly fullName: string;
  readonly gender: UserGender;
  readonly dateOfBirth: string;
  readonly passwordHash: string;
  readonly pepperVersion: number;
  readonly otpTokenHash: string;
  readonly otpExpiresAt: Date;
  readonly expiryCutoff: Date;
  readonly now: Date;
}

export interface ReissueEmailVerifyTokenParams {
  readonly userId: string;
  readonly otpTokenHash: string;
  readonly otpExpiresAt: Date;
  readonly now: Date;
}

export interface ReissueVerificationTokenParams {
  readonly userId: string;
  readonly purpose: VerificationTokenPurpose;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly now: Date;
}

export interface UpdateIdentityPasswordHashParams {
  readonly identityId: string;
  readonly userId: string;
  readonly passwordHash: string;
  readonly pepperVersion: number;
  readonly expectedCurrentPasswordHash?: string;
  readonly now: Date;
}

export interface CreateSessionParams {
  readonly id: string;
  readonly publicId: string;
  readonly userId: string;
  readonly familyId: string;
  readonly refreshTokenHash: string;
  readonly deviceInfo: string;
  readonly ipAddress: string;
  readonly lastUsedAt: Date;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export interface RotateSessionInFamilyParams {
  readonly previousSessionId: string;
  readonly newSession: CreateSessionParams;
  readonly rotatedAt: Date;
}

export interface RevokeAllUserSessionsParams {
  readonly userId: string;
  readonly excludeSessionId?: string;
  readonly excludeFamilyId?: string;
  readonly revokedAt: Date;
  readonly reason: string;
}

export interface IncrementFailedLoginParams {
  readonly identityId: string;
  readonly userId: string;
  readonly lockThreshold: number;
  readonly now: Date;
}

export interface IncrementFailedLoginResult {
  readonly failedLoginAttempts: number;
  readonly lockedNow: boolean;
  readonly userStatus: UserStatus;
}

/**
 * Tầng truy xuất dữ liệu PostgreSQL thuần túy cho phân hệ Auth & Session
 * (tách biệt hoàn toàn khỏi logic nghiệp vụ và tầng HTTP/Next.js).
 */
export class AuthRepository {
  private readonly getDefaultDb: () => Database;

  constructor(getDefaultDb: () => Database = () => getDb()) {
    this.getDefaultDb = getDefaultDb;
  }

  getDb(): Database {
    return this.getDefaultDb();
  }

  async findUserById(
    userId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<UserRow | null> {
    const rows = await executor.select().from(users).where(eq(users.id, userId)).limit(1);
    return rows[0] ?? null;
  }

  async findUserByUsername(
    usernameNormalized: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<UserRow | null> {
    const rows = await executor
      .select()
      .from(users)
      .where(eq(users.username, usernameNormalized))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Khóa dòng `users` trong DB Transaction theo thứ tự khóa chuẩn (`users` -> `advisory(familyId)`
   * -> `auth_identities`/`verification_tokens`/`sessions`) để triệt tiêu TOCTOU race condition và deadlock:
   * - `update`: tuần tự hóa mọi thay đổi trạng thái tài khoản, cấp lại/xác minh OTP và `revokeAllUserSessions`.
   * - `share`: cho phép nhiều thiết bị của cùng user đăng nhập/refresh song song nhưng đồng bộ chặt với `FOR UPDATE`.
   */
  async lockUserById(
    userId: string,
    tx: DatabaseTransaction,
    mode: 'update' | 'share' = 'update',
  ): Promise<UserRow | null> {
    const rows = await tx.select().from(users).where(eq(users.id, userId)).limit(1).for(mode);
    return rows[0] ?? null;
  }

  /**
   * Khóa transaction-scoped advisory lock trên `family_id` (64-bit SipHash) để tuần tự hóa tuyệt đối
   * các thao tác xoay vòng RT, Reuse Detection và thu hồi phiên trên cùng chuỗi thiết bị,
   * ngăn chặn phantom insert (RT3 sống sót dưới mức cô lập `READ COMMITTED`).
   */
  async acquireSessionFamilyLock(familyId: string, tx: DatabaseTransaction): Promise<void> {
    const lockKey = `tomato:session-family:${familyId}`;
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(CAST(${lockKey} AS text), CAST(0 AS bigint)))`,
    );
  }

  async findEmailIdentityWithUser(
    emailNormalized: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<IdentityWithUser | null> {
    const rows = await executor
      .select({
        user: users,
        identity: authIdentities,
      })
      .from(authIdentities)
      .innerJoin(users, eq(authIdentities.userId, users.id))
      .where(
        and(
          eq(authIdentities.provider, 'email_password'),
          eq(authIdentities.identifierNormalized, emailNormalized),
        ),
      )
      .limit(1);

    const match = rows[0];
    if (!match) {
      return null;
    }

    return {
      user: match.user,
      identity: match.identity,
    };
  }

  async findEmailIdentityByUserId(
    userId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<AuthIdentityRow | null> {
    const rows = await executor
      .select()
      .from(authIdentities)
      .where(and(eq(authIdentities.userId, userId), eq(authIdentities.provider, 'email_password')))
      .limit(1);
    return rows[0] ?? null;
  }

  async createPendingUserWithIdentityAndOtp(
    params: CreatePendingUserParams,
    tx: DatabaseTransaction,
  ): Promise<void> {
    await tx.insert(users).values({
      id: params.userId,
      publicId: params.publicId,
      username: params.username,
      fullName: params.fullName,
      gender: params.gender,
      dateOfBirth: params.dateOfBirth,
      status: 'pending_verification',
      createdAt: params.now,
      updatedAt: params.now,
    });

    await tx.insert(authIdentities).values({
      id: params.identityId,
      userId: params.userId,
      provider: 'email_password',
      identifierNormalized: params.emailNormalized,
      passwordHash: params.passwordHash,
      pepperVersion: params.pepperVersion,
      createdAt: params.now,
      updatedAt: params.now,
    });

    await tx.insert(verificationTokens).values({
      id: generateUuidV7(),
      userId: params.userId,
      purpose: 'email_verify',
      tokenHash: params.otpTokenHash,
      attemptCount: 0,
      expiresAt: params.otpExpiresAt,
      createdAt: params.now,
    });
  }

  /**
   * Đăng ký đè nguyên tử tài khoản `pending_verification` đã quá hạn (>= 24h):
   * khóa dòng `users` bằng `FOR UPDATE` trước khi kiểm tra lại trạng thái và mốc quá hạn
   * để chống tuyệt đối lỗ hổng TOCTOU Account Takeover nếu chủ tài khoản vừa xác minh thành `active`
   * hoặc một request khác vừa đăng ký đè trong lúc đang chạy Argon2id.
   */
  async overwriteExpiredPendingUserWithOtp(
    params: OverwriteExpiredPendingUserParams,
    tx: DatabaseTransaction,
  ): Promise<OverwritePendingUserOutcome> {
    const lockedUser = await this.lockUserById(params.userId, tx, 'update');
    if (!lockedUser) {
      return 'not_found';
    }
    if (lockedUser.status !== 'pending_verification') {
      return 'not_pending';
    }
    if (lockedUser.updatedAt.getTime() > params.expiryCutoff.getTime()) {
      return 'not_expired';
    }

    const updatedUsers = await tx
      .update(users)
      .set({
        username: params.username,
        fullName: params.fullName,
        gender: params.gender,
        dateOfBirth: params.dateOfBirth,
        updatedAt: params.now,
      })
      .where(and(eq(users.id, params.userId), eq(users.status, 'pending_verification')))
      .returning({ id: users.id });

    if (updatedUsers.length === 0) {
      return 'not_pending';
    }

    await tx
      .update(authIdentities)
      .set({
        passwordHash: params.passwordHash,
        pepperVersion: params.pepperVersion,
        verifiedAt: null,
        failedLoginAttempts: 0,
        updatedAt: params.now,
      })
      .where(
        and(eq(authIdentities.id, params.identityId), eq(authIdentities.userId, params.userId)),
      );

    await this.reissueEmailVerifyToken(
      {
        userId: params.userId,
        otpTokenHash: params.otpTokenHash,
        otpExpiresAt: params.otpExpiresAt,
        now: params.now,
      },
      tx,
    );

    return 'overwritten';
  }

  /**
   * Vô hiệu hóa toàn bộ mã token/OTP chưa dùng cùng `purpose` rồi chèn bản ghi mới trong cùng
   * transaction để tại mọi thời điểm chỉ có duy nhất 1 token còn hiệu lực cho mục đích đó.
   */
  async reissueVerificationToken(
    params: ReissueVerificationTokenParams,
    tx: DatabaseTransaction,
  ): Promise<void> {
    await tx
      .update(verificationTokens)
      .set({ consumedAt: params.now })
      .where(
        and(
          eq(verificationTokens.userId, params.userId),
          eq(verificationTokens.purpose, params.purpose),
          isNull(verificationTokens.consumedAt),
        ),
      );

    await tx.insert(verificationTokens).values({
      id: generateUuidV7(),
      userId: params.userId,
      purpose: params.purpose,
      tokenHash: params.tokenHash,
      attemptCount: 0,
      expiresAt: params.expiresAt,
      createdAt: params.now,
    });
  }

  /**
   * Vô hiệu hóa toàn bộ mã OTP xác minh email chưa dùng trước đó rồi mới tạo mã mới
   * trong cùng transaction để tại mọi thời điểm chỉ có duy nhất 1 OTP còn hiệu lực.
   */
  async reissueEmailVerifyToken(
    params: ReissueEmailVerifyTokenParams,
    tx: DatabaseTransaction,
  ): Promise<void> {
    await this.reissueVerificationToken(
      {
        userId: params.userId,
        purpose: 'email_verify',
        tokenHash: params.otpTokenHash,
        expiresAt: params.otpExpiresAt,
        now: params.now,
      },
      tx,
    );
  }

  /**
   * Đọc nhanh mã OTP chưa tiêu thụ mới nhất theo `purpose` (không khóa) dùng cho pre-check
   * trước khi chạy Argon2id tốn CPU; mọi kiểm tra chính thức vẫn chạy `FOR UPDATE` trong transaction.
   */
  async findLatestUnconsumedTokenByPurpose(
    userId: string,
    purpose: VerificationTokenPurpose,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<VerificationTokenRow | null> {
    const rows = await executor
      .select()
      .from(verificationTokens)
      .where(
        and(
          eq(verificationTokens.userId, userId),
          eq(verificationTokens.purpose, purpose),
          isNull(verificationTokens.consumedAt),
        ),
      )
      .orderBy(desc(verificationTokens.createdAt))
      .limit(1);

    return rows[0] ?? null;
  }

  /**
   * Khóa dòng `FOR UPDATE` trên mã OTP chưa tiêu thụ mới nhất theo `purpose`
   * để triệt tiêu race condition khi nhiều request thử sai OTP đồng thời cố vượt ngưỡng 5 lần thử.
   */
  async lockLatestUnconsumedTokenByPurpose(
    userId: string,
    purpose: VerificationTokenPurpose,
    tx: DatabaseTransaction,
  ): Promise<VerificationTokenRow | null> {
    const rows = await tx
      .select()
      .from(verificationTokens)
      .where(
        and(
          eq(verificationTokens.userId, userId),
          eq(verificationTokens.purpose, purpose),
          isNull(verificationTokens.consumedAt),
        ),
      )
      .orderBy(desc(verificationTokens.createdAt))
      .limit(1)
      .for('update');

    return rows[0] ?? null;
  }

  /**
   * Khóa dòng `FOR UPDATE` trên mã OTP `email_verify` đang hoạt động mới nhất để triệt tiêu
   * race condition khi nhiều request thử sai OTP đồng thời cố vượt ngưỡng 5 lần thử.
   */
  async lockLatestUnconsumedEmailVerifyToken(
    userId: string,
    tx: DatabaseTransaction,
  ): Promise<VerificationTokenRow | null> {
    return this.lockLatestUnconsumedTokenByPurpose(userId, 'email_verify', tx);
  }

  async findVerificationTokenByHash(
    purpose: VerificationTokenPurpose,
    tokenHash: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<VerificationTokenRow | null> {
    const rows = await executor
      .select()
      .from(verificationTokens)
      .where(
        and(eq(verificationTokens.purpose, purpose), eq(verificationTokens.tokenHash, tokenHash)),
      )
      .orderBy(desc(verificationTokens.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Tra cứu nhanh token/ticket thuộc đúng `(user_id, purpose, token_hash)` (không khóa)
   * dùng cho pre-check trước khi tiêu tốn CPU chạy Argon2id ở Bước 2 đổi mật khẩu.
   */
  async findVerificationTokenByHashForUser(
    userId: string,
    purpose: VerificationTokenPurpose,
    tokenHash: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<VerificationTokenRow | null> {
    const rows = await executor
      .select()
      .from(verificationTokens)
      .where(
        and(
          eq(verificationTokens.userId, userId),
          eq(verificationTokens.purpose, purpose),
          eq(verificationTokens.tokenHash, tokenHash),
        ),
      )
      .orderBy(desc(verificationTokens.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Khóa dòng `verification_tokens FOR UPDATE` theo đúng `(user_id, purpose, token_hash)`
   * SAU khi đã khóa `users FOR UPDATE` nhằm chống replay song song ticket đổi mật khẩu.
   */
  async lockVerificationTokenByHashForUser(
    userId: string,
    purpose: VerificationTokenPurpose,
    tokenHash: string,
    tx: DatabaseTransaction,
  ): Promise<VerificationTokenRow | null> {
    const rows = await tx
      .select()
      .from(verificationTokens)
      .where(
        and(
          eq(verificationTokens.userId, userId),
          eq(verificationTokens.purpose, purpose),
          eq(verificationTokens.tokenHash, tokenHash),
        ),
      )
      .orderBy(desc(verificationTokens.createdAt))
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  }

  /**
   * Khóa dòng `verification_tokens` bằng `FOR UPDATE` SAU khi đã khóa `users FOR UPDATE`
   * để tuân thủ thứ tự khóa chuẩn, chống deadlock và ngăn replay đồng thời 1 token đặt lại mật khẩu.
   */
  async lockVerificationTokenById(
    tokenId: string,
    userId: string,
    tx: DatabaseTransaction,
  ): Promise<VerificationTokenRow | null> {
    const rows = await tx
      .select()
      .from(verificationTokens)
      .where(and(eq(verificationTokens.id, tokenId), eq(verificationTokens.userId, userId)))
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  }

  async consumeAllUnconsumedTokensByPurpose(
    userId: string,
    purpose: VerificationTokenPurpose,
    consumedAt: Date,
    tx: DatabaseTransaction,
  ): Promise<void> {
    await tx
      .update(verificationTokens)
      .set({ consumedAt })
      .where(
        and(
          eq(verificationTokens.userId, userId),
          eq(verificationTokens.purpose, purpose),
          isNull(verificationTokens.consumedAt),
        ),
      );
  }

  /**
   * Mở khóa tài khoản từ trạng thái `locked` về `active` khi người dùng đặt lại mật khẩu thành công.
   * Chỉ khớp đúng điều kiện `status = 'locked'` để tuyệt đối không tự mở tài khoản `suspended`/`deleted`.
   */
  async unlockLockedUser(userId: string, now: Date, tx: DatabaseTransaction): Promise<boolean> {
    const rows = await tx
      .update(users)
      .set({
        status: 'active',
        updatedAt: now,
      })
      .where(and(eq(users.id, userId), eq(users.status, 'locked')))
      .returning({ id: users.id });
    return rows.length > 0;
  }

  async updateVerificationTokenAttempt(
    tokenId: string,
    userId: string,
    attemptCount: number,
    consumedAt: Date | null,
    tx: DatabaseTransaction,
  ): Promise<void> {
    await tx
      .update(verificationTokens)
      .set({
        attemptCount,
        consumedAt,
      })
      .where(and(eq(verificationTokens.id, tokenId), eq(verificationTokens.userId, userId)));
  }

  async consumeVerificationToken(
    tokenId: string,
    userId: string,
    consumedAt: Date,
    tx: DatabaseTransaction,
  ): Promise<void> {
    await tx
      .update(verificationTokens)
      .set({ consumedAt })
      .where(and(eq(verificationTokens.id, tokenId), eq(verificationTokens.userId, userId)));
  }

  async activateUserAndConsumeEmailVerifyTokens(
    userId: string,
    identityId: string,
    now: Date,
    tx: DatabaseTransaction,
  ): Promise<boolean> {
    const updatedUsers = await tx
      .update(users)
      .set({
        status: 'active',
        updatedAt: now,
      })
      .where(and(eq(users.id, userId), eq(users.status, 'pending_verification')))
      .returning({ id: users.id });

    if (updatedUsers.length === 0) {
      return false;
    }

    await tx
      .update(authIdentities)
      .set({
        verifiedAt: now,
        updatedAt: now,
      })
      .where(and(eq(authIdentities.id, identityId), eq(authIdentities.userId, userId)));

    await tx
      .update(verificationTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(verificationTokens.userId, userId),
          eq(verificationTokens.purpose, 'email_verify'),
          isNull(verificationTokens.consumedAt),
        ),
      );

    return true;
  }

  async updateIdentityPasswordHash(
    params: UpdateIdentityPasswordHashParams,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<boolean> {
    const conditions = [
      eq(authIdentities.id, params.identityId),
      eq(authIdentities.userId, params.userId),
    ];
    if (params.expectedCurrentPasswordHash !== undefined) {
      conditions.push(eq(authIdentities.passwordHash, params.expectedCurrentPasswordHash));
    }

    const updated = await executor
      .update(authIdentities)
      .set({
        passwordHash: params.passwordHash,
        pepperVersion: params.pepperVersion,
        updatedAt: params.now,
      })
      .where(and(...conditions))
      .returning({ id: authIdentities.id });

    return updated.length > 0;
  }

  async resetFailedLoginAttempts(
    identityId: string,
    userId: string,
    now: Date,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<void> {
    await executor
      .update(authIdentities)
      .set({
        failedLoginAttempts: 0,
        updatedAt: now,
      })
      .where(and(eq(authIdentities.id, identityId), eq(authIdentities.userId, userId)));
  }

  /**
   * Tăng nguyên tử `auth_identities.failed_login_attempts` trong DB Transaction đã khóa `users FOR UPDATE`
   * để chống race condition khi nhiều request sai mật khẩu chạy song song từ nhiều IP (Mục 4.2):
   * - Chỉ chuyển trạng thái `active -> locked` đúng 1 lần duy nhất khi chạm ngưỡng (`>= lockThreshold`).
   * - Tuyệt đối không ghi đè các trạng thái `pending_verification`, `suspended`, `deleted` sang `locked`.
   */
  async incrementFailedLoginAttemptsAndMaybeLock(
    params: IncrementFailedLoginParams,
    tx: DatabaseTransaction,
  ): Promise<IncrementFailedLoginResult | null> {
    const lockedUser = await this.lockUserById(params.userId, tx, 'update');
    if (!lockedUser) {
      return null;
    }

    if (lockedUser.status !== 'active') {
      const identity = await this.findEmailIdentityByUserId(lockedUser.id, tx);
      return {
        failedLoginAttempts: identity?.failedLoginAttempts ?? 0,
        lockedNow: false,
        userStatus: lockedUser.status,
      };
    }

    const updatedIdentities = await tx
      .update(authIdentities)
      .set({
        failedLoginAttempts: sql`${authIdentities.failedLoginAttempts} + 1`,
        updatedAt: params.now,
      })
      .where(
        and(eq(authIdentities.id, params.identityId), eq(authIdentities.userId, params.userId)),
      )
      .returning({ failedLoginAttempts: authIdentities.failedLoginAttempts });

    const nextAttempts = updatedIdentities[0]?.failedLoginAttempts;
    if (nextAttempts === undefined) {
      return null;
    }

    let lockedNow = false;
    let nextStatus: UserStatus = lockedUser.status;
    if (nextAttempts >= params.lockThreshold) {
      const lockedRows = await tx
        .update(users)
        .set({
          status: 'locked',
          updatedAt: params.now,
        })
        .where(and(eq(users.id, params.userId), eq(users.status, 'active')))
        .returning({ id: users.id });

      if (lockedRows.length > 0) {
        lockedNow = true;
        nextStatus = 'locked';
      }
    }

    return {
      failedLoginAttempts: nextAttempts,
      lockedNow,
      userStatus: nextStatus,
    };
  }

  async createSession(
    params: CreateSessionParams,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<SessionRow> {
    const rows = await executor
      .insert(sessions)
      .values({
        id: params.id,
        publicId: params.publicId,
        userId: params.userId,
        familyId: params.familyId,
        refreshTokenHash: params.refreshTokenHash,
        deviceInfo: params.deviceInfo,
        ipAddress: params.ipAddress,
        lastUsedAt: params.lastUsedAt,
        expiresAt: params.expiresAt,
        createdAt: params.createdAt,
      })
      .returning();

    const created = rows[0];
    if (!created) {
      throw new Error('Không thể tạo bản ghi phiên đăng nhập mới');
    }
    return created;
  }

  async findSessionWithUserByPublicId(
    sessionPublicId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<SessionWithUser | null> {
    const rows = await executor
      .select({
        session: sessions,
        user: users,
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(eq(sessions.publicId, sessionPublicId))
      .limit(1);

    const match = rows[0];
    if (!match) {
      return null;
    }

    return {
      session: match.session,
      user: match.user,
    };
  }

  /**
   * Tra cứu phiên kèm điều kiện chủ sở hữu `user_id` ngay tại tầng SQL (phòng thủ chiều sâu chống IDOR).
   */
  async findSessionByPublicIdForUser(
    sessionPublicId: string,
    userId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<SessionRow | null> {
    const rows = await executor
      .select()
      .from(sessions)
      .where(and(eq(sessions.publicId, sessionPublicId), eq(sessions.userId, userId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async findSessionByRefreshTokenHash(
    refreshTokenHash: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<SessionRow | null> {
    const rows = await executor
      .select()
      .from(sessions)
      .where(eq(sessions.refreshTokenHash, refreshTokenHash))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Khóa đồng bộ đa lớp trong DB Transaction theo thứ tự khóa chuẩn (`users FOR SHARE` ->
   * `pg_advisory_xact_lock(familyId)` -> `sessions FOR UPDATE`) để triệt tiêu:
   * 1. Race condition khi 2 yêu cầu `/refresh` dùng cùng 1 Refresh Token chạy song song.
   * 2. Phantom insert (RT3 sống sót) khi `RT1` Reuse Detection chạy song song với xoay vòng `RT2 -> RT3`.
   * 3. Race condition giữa `/refresh` đang chèn RT mới và `revokeAllUserSessions` (`users FOR UPDATE`).
   */
  async lockSessionByRefreshTokenHash(
    refreshTokenHash: string,
    tx: DatabaseTransaction,
  ): Promise<SessionRow | null> {
    const metaRows = await tx
      .select({
        userId: sessions.userId,
        familyId: sessions.familyId,
      })
      .from(sessions)
      .where(eq(sessions.refreshTokenHash, refreshTokenHash))
      .limit(1);

    const meta = metaRows[0];
    if (!meta) {
      return null;
    }

    await this.lockUserById(meta.userId, tx, 'share');
    await this.acquireSessionFamilyLock(meta.familyId, tx);

    const rows = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.refreshTokenHash, refreshTokenHash))
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  }

  /**
   * Xoay vòng Refresh Token theo mô hình Append-Only Rotated Rows (Phương án 1A):
   * đánh dấu bản ghi cũ đã được xoay vòng (`token_rotated`) và giữ lại bản băm RT1 trong bảng
   * nhằm phát hiện tấn công tái sử dụng (Reuse Detection), đồng thời chèn bản ghi RT2 cùng `family_id`.
   */
  async rotateSessionInFamily(
    params: RotateSessionInFamilyParams,
    tx: DatabaseTransaction,
  ): Promise<SessionRow | null> {
    const rotated = await tx
      .update(sessions)
      .set({
        revokedAt: params.rotatedAt,
        revokeReason: 'token_rotated',
      })
      .where(
        and(
          eq(sessions.id, params.previousSessionId),
          eq(sessions.userId, params.newSession.userId),
          isNull(sessions.revokedAt),
        ),
      )
      .returning({ id: sessions.id });

    if (rotated.length === 0) {
      return null;
    }

    return this.createSession(params.newSession, tx);
  }

  /**
   * Thu hồi nguyên tử TOÀN BỘ phiên chưa bị thu hồi thuộc cùng `family_id` và đúng `user_id` (Reuse Detection).
   * Chỉ cập nhật dòng `revoked_at IS NULL` để bảo toàn dấu vết `token_rotated` của các bước trước.
   */
  async revokeSessionFamily(
    familyId: string,
    userId: string,
    revokedAt: Date,
    reason: string,
    tx: DatabaseTransaction,
  ): Promise<readonly string[]> {
    const rows = await tx
      .update(sessions)
      .set({
        revokedAt,
        revokeReason: reason,
      })
      .where(
        and(
          eq(sessions.familyId, familyId),
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
        ),
      )
      .returning({ id: sessions.id });

    return rows.map((row) => row.id);
  }

  async revokeSessionById(
    sessionId: string,
    userId: string,
    revokedAt: Date,
    reason: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<boolean> {
    const rows = await executor
      .update(sessions)
      .set({
        revokedAt,
        revokeReason: reason,
      })
      .where(
        and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt)),
      )
      .returning({ id: sessions.id });

    return rows.length > 0;
  }

  async listActiveSessionsByUserId(
    userId: string,
    now: Date,
    idleCutoff: Date,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<SessionRow[]> {
    return executor
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, now),
          gt(sessions.lastUsedAt, idleCutoff),
        ),
      )
      .orderBy(desc(sessions.lastUsedAt), desc(sessions.createdAt));
  }

  /**
   * Cập nhật thời điểm hoạt động gần nhất (`last_used_at`) cho phiên đang hoạt động
   * (được gọi có tiết lưu 5 phút/lần từ `authenticateAccessToken` để hiển thị trạng thái Online chính xác).
   */
  async touchSessionLastUsedAt(
    sessionId: string,
    userId: string,
    now: Date,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<void> {
    await executor
      .update(sessions)
      .set({ lastUsedAt: now })
      .where(
        and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt)),
      );
  }

  /**
   * Lấy danh sách thiết bị đang hoạt động và lịch sử đăng nhập gần nhất của user, gom nhóm chặt theo `family_id`:
   * - Mỗi chuỗi xoay vòng Refresh Token (`family_id`) chỉ trả đúng 1 bản ghi đại diện mới nhất
   *   (loại hoàn toàn bản ghi trung gian `revoke_reason = 'token_rotated'`).
   * - Lọc `revoke_reason IS DISTINCT FROM 'password_changed_rotated'` ở truy vấn ngoài để không tạo
   *   dòng lịch sử giả khi cùng thiết bị vừa xoay vòng sang `family_id` mới lúc đổi mật khẩu.
   */
  async listLatestSessionsPerFamilyByUserId(
    userId: string,
    limit: number,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<SessionRow[]> {
    const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
    const result = await executor.execute(sql`
      SELECT
        id,
        public_id,
        user_id,
        family_id,
        refresh_token_hash,
        device_info,
        ip_address,
        last_used_at,
        expires_at,
        revoked_at,
        revoke_reason,
        created_at
      FROM (
        SELECT DISTINCT ON (family_id)
          id,
          public_id,
          user_id,
          family_id,
          refresh_token_hash,
          device_info,
          ip_address,
          last_used_at,
          expires_at,
          revoked_at,
          revoke_reason,
          created_at
        FROM sessions
        WHERE user_id = ${userId}::uuid
        ORDER BY
          family_id,
          (revoked_at IS NULL) DESC,
          last_used_at DESC,
          id DESC
      ) AS latest_per_family
      WHERE revoke_reason IS DISTINCT FROM 'password_changed_rotated'
      ORDER BY last_used_at DESC, id DESC
      LIMIT ${safeLimit}
    `);

    const rawRows = (
      result as unknown as {
        readonly rows: ReadonlyArray<{
          readonly id: string;
          readonly public_id: string;
          readonly user_id: string;
          readonly family_id: string;
          readonly refresh_token_hash: string;
          readonly device_info: string | null;
          readonly ip_address: string;
          readonly last_used_at: Date | string;
          readonly expires_at: Date | string;
          readonly revoked_at: Date | string | null;
          readonly revoke_reason: string | null;
          readonly created_at: Date | string;
        }>;
      }
    ).rows;

    return rawRows.map((row) => ({
      id: row.id,
      publicId: row.public_id,
      userId: row.user_id,
      familyId: row.family_id,
      refreshTokenHash: row.refresh_token_hash,
      deviceInfo: row.device_info,
      ipAddress: row.ip_address,
      lastUsedAt: row.last_used_at instanceof Date ? row.last_used_at : new Date(row.last_used_at),
      expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at),
      revokedAt:
        row.revoked_at === null
          ? null
          : row.revoked_at instanceof Date
            ? row.revoked_at
            : new Date(row.revoked_at),
      revokeReason: row.revoke_reason,
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    }));
  }

  async revokeAllUserSessions(
    params: RevokeAllUserSessionsParams,
    tx: DatabaseTransaction,
  ): Promise<number> {
    // Bắt buộc nhận `tx: DatabaseTransaction` để lệnh khóa `users FOR UPDATE` thực sự giữ khóa
    // cho đến hết thao tác cập nhật, đồng bộ tuyệt đối với các giao dịch `/refresh` (`users FOR SHARE`).
    await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, params.userId))
      .limit(1)
      .for('update');

    const conditions = [eq(sessions.userId, params.userId), isNull(sessions.revokedAt)];
    if (params.excludeSessionId) {
      conditions.push(ne(sessions.id, params.excludeSessionId));
    }
    if (params.excludeFamilyId) {
      conditions.push(ne(sessions.familyId, params.excludeFamilyId));
    }

    const rows = await tx
      .update(sessions)
      .set({
        revokedAt: params.revokedAt,
        revokeReason: params.reason,
      })
      .where(and(...conditions))
      .returning({ id: sessions.id });

    return rows.length;
  }
}
