import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { generatePublicId, generateUuidV7 } from '@/core/crypto/id';
import { hashTokenSha256 } from '@/core/crypto/token';
import { closeDatabasePool, getDb } from '@/core/db';
import { auditLogs, authIdentities, sessions, users, verificationTokens } from '@/core/db/schema';
import { RateLimiter, closeRedisClient, getRedisClient } from '@/core/redis';
import { AuditLogService } from '@/core/security/audit-log.service';

describe('Integration M1: Drizzle Schema (5 bảng), AuditLogService & Redis RateLimiter', () => {
  afterAll(async () => {
    await Promise.all([closeDatabasePool(), closeRedisClient()]);
  });

  it('xác minh 5 bảng PostgreSQL, UNIQUE constraint, ON DELETE CASCADE và AuditLogService hoạt động thực tế', async () => {
    const db = getDb();
    const auditService = new AuditLogService(() => db);

    const userId = generateUuidV7();
    const publicId = generatePublicId();
    const email = `m1-integration-${Date.now()}@tomato.test`;
    const refreshHash = hashTokenSha256(`rt-${Date.now()}-${Math.random()}`);
    const otpHash = hashTokenSha256(`otp-${Date.now()}-${Math.random()}`);

    const auditRecord = await (async () => {
      const m1Username = `m1_${Date.now().toString(36)}`;
      await db.insert(users).values({
        id: userId,
        publicId,
        username: m1Username,
        handle: m1Username,
        handleNormalized: m1Username,
        fullName: 'M1 Test User',
        gender: 'other',
        dateOfBirth: '2000-01-15',
      });

      await db.insert(authIdentities).values({
        id: generateUuidV7(),
        userId,
        provider: 'email_password',
        identifierNormalized: email,
        passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$salt$hash',
        pepperVersion: 1,
      });

      // Ràng buộc UNIQUE (provider, identifier_normalized) phải chặn trùng email.
      await expect(
        db.insert(authIdentities).values({
          id: generateUuidV7(),
          userId,
          provider: 'email_password',
          identifierNormalized: email,
          passwordHash: null,
          pepperVersion: 1,
        }),
      ).rejects.toThrow();

      await db.insert(sessions).values({
        id: generateUuidV7(),
        publicId: generatePublicId(),
        userId,
        familyId: generateUuidV7(),
        refreshTokenHash: refreshHash,
        deviceInfo: 'Vitest / Node 24',
        ipAddress: '127.0.0.1',
        expiresAt: new Date(Date.now() + 86_400_000),
      });

      await db.insert(verificationTokens).values({
        id: generateUuidV7(),
        userId,
        purpose: 'email_verify',
        tokenHash: otpHash,
        expiresAt: new Date(Date.now() + 900_000),
      });

      return auditService.record({
        userId,
        action: 'REGISTER',
        ipAddress: '127.0.0.1',
        userAgent: 'Vitest Integration',
        metadata: {
          channel: 'web',
          password: 'MustBeStrippedBeforeDbInsert!',
          otpCode: '123456',
        },
      });
    })();

    try {
      const storedLogs = await db.select().from(auditLogs).where(eq(auditLogs.id, auditRecord.id));
      expect(storedLogs).toHaveLength(1);
      expect(storedLogs[0]?.userId).toBe(userId);
      expect(storedLogs[0]?.metadata).toEqual({ channel: 'web' });

      // Xóa user phải ON DELETE CASCADE cho auth_identities/sessions/verification_tokens
      // và ON DELETE SET NULL cho audit_logs (bảo toàn bằng chứng kiểm toán).
      await db.delete(users).where(eq(users.id, userId));

      const remainingIdentities = await db
        .select()
        .from(authIdentities)
        .where(eq(authIdentities.userId, userId));
      const remainingSessions = await db.select().from(sessions).where(eq(sessions.userId, userId));
      const remainingTokens = await db
        .select()
        .from(verificationTokens)
        .where(eq(verificationTokens.userId, userId));
      const preservedAudit = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.id, auditRecord.id));

      expect(remainingIdentities).toHaveLength(0);
      expect(remainingSessions).toHaveLength(0);
      expect(remainingTokens).toHaveLength(0);
      expect(preservedAudit).toHaveLength(1);
      expect(preservedAudit[0]?.userId).toBeNull();
    } finally {
      await db.delete(auditLogs).where(eq(auditLogs.id, auditRecord.id));
      await db.delete(users).where(eq(users.id, userId));
    }
  });

  it('RateLimiter chặn đúng ngưỡng và trả retryAfterSeconds > 0 trên Redis thật', async () => {
    const redis = getRedisClient();
    const limiter = new RateLimiter(redis, { keyPrefix: 'tomato:m1:itest' });
    const slidingKey = `sliding:${Date.now()}`;
    const fixedKey = `fixed:${Date.now()}`;

    try {
      const ruleSliding = { limit: 2, windowSeconds: 30, strategy: 'sliding_window' as const };
      const r1 = await limiter.consume(slidingKey, ruleSliding);
      const r2 = await limiter.consume(slidingKey, ruleSliding);
      const r3 = await limiter.consume(slidingKey, ruleSliding);

      expect(r1.allowed).toBe(true);
      expect(r1.remaining).toBe(1);
      expect(r2.allowed).toBe(true);
      expect(r2.remaining).toBe(0);
      expect(r3.allowed).toBe(false);
      expect(r3.remaining).toBe(0);
      expect(r3.retryAfterSeconds).toBeGreaterThanOrEqual(1);

      const ruleFixed = { limit: 1, windowSeconds: 30, strategy: 'fixed_window' as const };
      const f1 = await limiter.consume(fixedKey, ruleFixed);
      const f2 = await limiter.consume(fixedKey, ruleFixed);

      expect(f1.allowed).toBe(true);
      expect(f2.allowed).toBe(false);
      expect(f2.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    } finally {
      await limiter.reset(slidingKey, { windowSeconds: 30, strategy: 'sliding_window' });
      await limiter.reset(fixedKey, { windowSeconds: 30, strategy: 'fixed_window' });
    }
  });
});
