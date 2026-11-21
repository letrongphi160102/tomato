import 'server-only';

import { and, desc, eq, gt, isNull, ne } from 'drizzle-orm';

import { generateUuidV7 } from '@/core/crypto/id';
import { getDb, type Database, type DatabaseTransaction, type DbExecutor } from '@/core/db';
import {
  authIdentities,
  sessions,
  users,
  verificationTokens,
  type AuthIdentityRow,
  type SessionRow,
  type UserRow,
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
  readonly displayName: string;
  readonly dateOfBirth: string;
  readonly passwordHash: string;
  readonly pepperVersion: number;
  readonly otpTokenHash: string;
  readonly otpExpiresAt: Date;
  readonly now: Date;
}

export interface OverwriteExpiredPendingUserParams {
  readonly userId: string;
  readonly identityId: string;
  readonly displayName: string;
  readonly dateOfBirth: string;
  readonly passwordHash: string;
  readonly pepperVersion: number;
  readonly otpTokenHash: string;
  readonly otpExpiresAt: Date;
  readonly now: Date;
}

export interface ReissueEmailVerifyTokenParams {
  readonly userId: string;
  readonly otpTokenHash: string;
  readonly otpExpiresAt: Date;
  readonly now: Date;
}

export interface UpdateIdentityPasswordHashParams {
  readonly identityId: string;
  readonly passwordHash: string;
  readonly pepperVersion: number;
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
  readonly revokedAt: Date;
  readonly reason: string;
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

  async createPendingUserWithIdentityAndOtp(
    params: CreatePendingUserParams,
    tx: DatabaseTransaction,
  ): Promise<void> {
    await tx.insert(users).values({
      id: params.userId,
      publicId: params.publicId,
      displayName: params.displayName,
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

  async overwriteExpiredPendingUserWithOtp(
    params: OverwriteExpiredPendingUserParams,
    tx: DatabaseTransaction,
  ): Promise<void> {
    await tx
      .update(users)
      .set({
        displayName: params.displayName,
        dateOfBirth: params.dateOfBirth,
        updatedAt: params.now,
      })
      .where(and(eq(users.id, params.userId), eq(users.status, 'pending_verification')));

    await tx
      .update(authIdentities)
      .set({
        passwordHash: params.passwordHash,
        pepperVersion: params.pepperVersion,
        updatedAt: params.now,
      })
      .where(eq(authIdentities.id, params.identityId));

    await this.reissueEmailVerifyToken(
      {
        userId: params.userId,
        otpTokenHash: params.otpTokenHash,
        otpExpiresAt: params.otpExpiresAt,
        now: params.now,
      },
      tx,
    );
  }

  /**
   * Vô hiệu hóa toàn bộ mã OTP xác minh email chưa dùng trước đó rồi mới tạo mã mới
   * trong cùng transaction để tại mọi thời điểm chỉ có duy nhất 1 OTP còn hiệu lực.
   */
  async reissueEmailVerifyToken(
    params: ReissueEmailVerifyTokenParams,
    tx: DatabaseTransaction,
  ): Promise<void> {
    await tx
      .update(verificationTokens)
      .set({ consumedAt: params.now })
      .where(
        and(
          eq(verificationTokens.userId, params.userId),
          eq(verificationTokens.purpose, 'email_verify'),
          isNull(verificationTokens.consumedAt),
        ),
      );

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
   * Khóa dòng `FOR UPDATE` trên mã OTP `email_verify` đang hoạt động mới nhất để triệt tiêu
   * race condition khi nhiều request thử sai OTP đồng thời cố vượt ngưỡng 5 lần thử.
   */
  async lockLatestUnconsumedEmailVerifyToken(
    userId: string,
    tx: DatabaseTransaction,
  ): Promise<VerificationTokenRow | null> {
    const rows = await tx
      .select()
      .from(verificationTokens)
      .where(
        and(
          eq(verificationTokens.userId, userId),
          eq(verificationTokens.purpose, 'email_verify'),
          isNull(verificationTokens.consumedAt),
        ),
      )
      .orderBy(desc(verificationTokens.createdAt))
      .limit(1)
      .for('update');

    return rows[0] ?? null;
  }

  async updateVerificationTokenAttempt(
    tokenId: string,
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
      .where(eq(verificationTokens.id, tokenId));
  }

  async consumeVerificationToken(
    tokenId: string,
    consumedAt: Date,
    tx: DatabaseTransaction,
  ): Promise<void> {
    await tx
      .update(verificationTokens)
      .set({ consumedAt })
      .where(eq(verificationTokens.id, tokenId));
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
      .where(eq(authIdentities.id, identityId));

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
  ): Promise<void> {
    await executor
      .update(authIdentities)
      .set({
        passwordHash: params.passwordHash,
        pepperVersion: params.pepperVersion,
        updatedAt: params.now,
      })
      .where(eq(authIdentities.id, params.identityId));
  }

  async resetFailedLoginAttempts(
    identityId: string,
    now: Date,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<void> {
    await executor
      .update(authIdentities)
      .set({
        failedLoginAttempts: 0,
        updatedAt: now,
      })
      .where(eq(authIdentities.id, identityId));
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

  async findSessionByPublicId(
    sessionPublicId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<SessionRow | null> {
    const rows = await executor
      .select()
      .from(sessions)
      .where(eq(sessions.publicId, sessionPublicId))
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
   * Khóa dòng `FOR UPDATE` theo `refresh_token_hash` trong DB Transaction để triệt tiêu
   * race condition khi 2 yêu cầu `/refresh` dùng cùng 1 Refresh Token chạy song song.
   */
  async lockSessionByRefreshTokenHash(
    refreshTokenHash: string,
    tx: DatabaseTransaction,
  ): Promise<SessionRow | null> {
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
      .where(and(eq(sessions.id, params.previousSessionId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });

    if (rotated.length === 0) {
      return null;
    }

    return this.createSession(params.newSession, tx);
  }

  /**
   * Thu hồi nguyên tử TOÀN BỘ phiên chưa bị thu hồi thuộc cùng `family_id` (Reuse Detection).
   * Chỉ cập nhật dòng `revoked_at IS NULL` để bảo toàn dấu vết `token_rotated` của các bước trước.
   */
  async revokeSessionFamily(
    familyId: string,
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
      .where(and(eq(sessions.familyId, familyId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });

    return rows.map((row) => row.id);
  }

  async revokeSessionById(
    sessionId: string,
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
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
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

  async revokeAllUserSessions(
    params: RevokeAllUserSessionsParams,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<number> {
    const conditions = [eq(sessions.userId, params.userId), isNull(sessions.revokedAt)];
    if (params.excludeSessionId) {
      conditions.push(ne(sessions.id, params.excludeSessionId));
    }

    const rows = await executor
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
