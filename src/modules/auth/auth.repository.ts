import 'server-only';

import { and, desc, eq, isNull } from 'drizzle-orm';

import { generateUuidV7 } from '@/core/crypto/id';
import { getDb, type Database, type DatabaseTransaction, type DbExecutor } from '@/core/db';
import {
  authIdentities,
  users,
  verificationTokens,
  type AuthIdentityRow,
  type UserRow,
  type VerificationTokenRow,
} from '@/core/db/schema';

export interface IdentityWithUser {
  readonly user: UserRow;
  readonly identity: AuthIdentityRow;
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

/**
 * Tầng truy xuất dữ liệu PostgreSQL thuần túy cho phân hệ Auth (tách khỏi logic nghiệp vụ và HTTP).
 */
export class AuthRepository {
  private readonly getDefaultDb: () => Database;

  constructor(getDefaultDb: () => Database = () => getDb()) {
    this.getDefaultDb = getDefaultDb;
  }

  getDb(): Database {
    return this.getDefaultDb();
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
}
